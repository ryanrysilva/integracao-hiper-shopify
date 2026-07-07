// src/services/sync.js
const fs = require('fs');
const request = require('../utils/request.js');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarPedidosShopify,
  sleep
} = require('./shopify.js');

const STATE_PATH = 'state.json';

let ESTADO = {
  ultimoPedidoId: 0,
  pontoDeSincronizacao: 0,
  mapaSkuHiper: {},      // sku -> id do produto no Hiper (usado pra enviar pedidos)
  produtosMap: {}        // hiperId -> { shopifyId, variants: [{ sku, variantId, inventoryItemId }] }
};

if (fs.existsSync(STATE_PATH)) {
  try {
    ESTADO = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (isNaN(ESTADO.pontoDeSincronizacao) || ESTADO.pontoDeSincronizacao < 0) ESTADO.pontoDeSincronizacao = 0;
    if (!ESTADO.mapaSkuHiper || typeof ESTADO.mapaSkuHiper !== 'object') ESTADO.mapaSkuHiper = {};
    if (!ESTADO.produtosMap || typeof ESTADO.produtosMap !== 'object') ESTADO.produtosMap = {};
  } catch (e) {
    console.warn('⚠️ state.json corrompido, resetando...');
    ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0, mapaSkuHiper: {}, produtosMap: {} };
  }
}

function salvarEstado() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(ESTADO, null, 2));
}

// Converte o retorno de criação/atualização (REST) no formato compacto que guardamos no mapa
function extrairMapaProduto(produtoShopifyResp) {
  return {
    shopifyId: produtoShopifyResp.id,
    variants: (produtoShopifyResp.variants || []).map(v => ({
      sku: v.sku,
      variantId: v.id,
      inventoryItemId: v.inventory_item_id
    }))
  };
}

// Converte o registro do mapa local de volta pro formato que atualizarProdutoShopify espera
function mapaParaProdutoExistente(mapaEntry) {
  return {
    id: mapaEntry.shopifyId,
    variants: mapaEntry.variants.map(v => ({
      id: v.variantId,
      sku: v.sku,
      inventory_item_id: v.inventoryItemId,
      title: v.sku // não usamos "Default Title" aqui pois o mapa local já reflete o estado real
    }))
  };
}

// ============================================================
// BUSCA PRODUTO PELO METAFIELD (via GraphQL) — usada só como
// PLANO B, quando o produto não está no mapa local (produtosMap).
// Mantida porque a busca da Shopify pode eventualmente encontrar
// produtos criados manualmente ou antes de existir o mapa local.
// ============================================================
async function buscarProdutoPorMetafield(token, hiperId) {
  console.log(`🔍 [fallback] Buscando produto pelo metafield: hiper.product_id = ${hiperId}`);

  const query = `{
    products(first: 1, query: "metafields.hiper.product_id:'${hiperId}'") {
      edges {
        node {
          id
          title
          metafields(first: 10) {
            edges { node { namespace key value } }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }`;

  const opcoes = {
    hostname: `${process.env.SHOPIFY_STORE}.myshopify.com`,
    path: '/admin/api/2026-07/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };

  try {
    const res = await request(opcoes, JSON.stringify({ query }));
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    const edges = res.data?.products?.edges || [];
    if (edges.length === 0) return null;

    const product = edges[0].node;
    const metafields = product.metafields.edges.map(edge => ({
      namespace: edge.node.namespace,
      key: edge.node.key,
      value: edge.node.value
    }));

    const metafieldConfere = metafields.some(
      mf => mf.namespace === 'hiper' && mf.key === 'product_id' && mf.value === hiperId
    );
    if (!metafieldConfere) return null;

    return {
      id: product.id.replace('gid://shopify/Product/', ''),
      title: product.title,
      variants: product.variants.edges.map(edge => ({
        id: edge.node.id.replace('gid://shopify/ProductVariant/', ''),
        title: edge.node.title,
        sku: edge.node.sku,
        price: edge.node.price,
        inventory_quantity: edge.node.inventoryQuantity,
        inventory_item_id: edge.node.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
      })),
      metafields
    };
  } catch (err) {
    console.error(`❌ Erro no fallback de busca por metafield ${hiperId}:`, err.message);
    return null;
  }
}

// ============================================================
// FUNÇÃO PRINCIPAL DE SINCRONIZAÇÃO
// ============================================================
async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');

  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    let produtos = [];
    let ponto = 0;
    let pontoOriginal = ESTADO.pontoDeSincronizacao;

    try {
      const resposta = await buscarProdutosHiper(tokenHiper, pontoOriginal);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
    } catch (erro) {
      console.warn(`⚠️ Erro ao buscar com ponto ${pontoOriginal}: ${erro.message}`);
      console.warn('🔄 Tentando sincronização completa com ponto=0...');
      const resposta = await buscarProdutosHiper(tokenHiper, 0);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
    }

    if (produtos.length === 0) {
      console.warn('⚠️ Nenhum produto encontrado.');
    } else {
      console.log(`✅ ${produtos.length} produtos encontrados no Hiper.`);
    }

    // mapaSkuHiper cumulativo (usado no envio de pedidos pro Hiper)
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => { if (v.codigoDeBarras) ESTADO.mapaSkuHiper[v.codigoDeBarras] = v.id; });
      } else {
        if (produto.codigoDeBarras) ESTADO.mapaSkuHiper[produto.codigoDeBarras] = produto.id;
      }
    }
    const mapaSkuHiper = ESTADO.mapaSkuHiper;

    let criados = 0;
    let atualizados = 0;

    // ============================================================
    // CRIA OU ATUALIZA PRODUTOS — agora consultando primeiro o
    // MAPA LOCAL (produtosMap), não a busca da Shopify.
    // A busca (metafield/SKU) só entra como plano B, quando o
    // hiperId ainda não está no mapa local.
    // ============================================================
    console.log('\n🚀 Criando/atualizando produtos...');
    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue;
      if (produto.produtoPrimarioId && produto.produtoPrimarioId !== '00000000-0000-0000-0000-000000000000') continue;

      try {
        let sku = produto.codigoDeBarras;
        if (!sku && produto.variacao && produto.variacao.length > 0) {
          sku = produto.variacao[0].codigoDeBarras;
        }
        if (!sku) {
          console.warn(`⚠️ Produto "${produto.nome}" sem SKU. Ignorando.`);
          continue;
        }

        const mapaEntry = ESTADO.produtosMap[produto.id];

        if (mapaEntry) {
          // ✅ Já sabemos o ID do Shopify — sem precisar buscar. Rápido e confiável.
          console.log(`📦 Produto "${produto.nome}" já mapeado (Shopify ID: ${mapaEntry.shopifyId}). Atualizando...`);
          const produtoExistente = mapaParaProdutoExistente(mapaEntry);
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente);
          if (atualizado) {
            ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
            atualizados++;
          }
        } else {
          // Plano B: produto não está no nosso mapa ainda. Tenta achar na Shopify
          // (pode ser produto antigo, criado manualmente, ou de antes desta versão do código).
          let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
          if (!existe) {
            existe = await buscarProdutoPorSKU(tokenShopify, sku);
          }

          if (existe) {
            console.log(`📦 Produto "${produto.nome}" encontrado via busca (SKU: ${sku}). Atualizando e mapeando...`);
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
              atualizados++;
            }
          } else {
            console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(novo);
              criados++;
            }
          }
        }

        // Salva a cada produto processado — se o processo cair no meio do caminho
        // (ex: reinício no Render), não perdemos o que já foi mapeado até aqui.
        salvarEstado();

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
      await sleep(400); // respiro entre produtos pra evitar rate limit
    }

    if (produtos.length > 0 && (criados > 0 || atualizados > 0)) {
      if (ponto && !isNaN(ponto) && ponto >= 0 && ponto > ESTADO.pontoDeSincronizacao) {
        ESTADO.pontoDeSincronizacao = ponto;
        console.log(`📌 Ponto de sincronização atualizado para ${ponto}`);
      } else {
        console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) mantido.`);
      }
    } else {
      console.log(`📌 Nenhum produto processado com sucesso. Ponto NÃO alterado.`);
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);

    salvarEstado();

    // --- PEDIDOS ---
    const pedidos = await buscarPedidosShopify(tokenShopify, ESTADO.ultimoPedidoId || 0);
    let enviados = 0;
    const pedidosEnviados = [];
    for (const pedido of pedidos) {
      try {
        const resultado = await enviarPedidoParaHiper(tokenHiper, pedido, mapaSkuHiper);
        if (resultado) {
          enviados++;
          pedidosEnviados.push({ orderNumber: pedido.order_number, hiperId: resultado.id });
        }
        if (pedido.id > ESTADO.ultimoPedidoId) ESTADO.ultimoPedidoId = pedido.id;
      } catch (erro) {
        console.error(`❌ Erro ao enviar pedido #${pedido.order_number}:`, erro.message);
      }
      await sleep(300);
    }

    console.log(`\n--- SINC. PEDIDOS CONCLUÍDA ---`);
    console.log(`📦 ${enviados} pedidos enviados para o Hiper.`);

    if (pedidosEnviados.length > 0) {
      console.log(`\n--- CONSULTANDO STATUS DOS PEDIDOS ENVIADOS ---`);
      for (const p of pedidosEnviados) {
        try {
          await consultarPedidoHiper(tokenHiper, p.hiperId);
        } catch (erro) {
          console.error(`❌ Erro ao consultar pedido ${p.hiperId}:`, erro.message);
        }
        await sleep(300);
      }
    }

    salvarEstado();
    console.log(`\n✅ ESTADO SALVO.`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
  }
}

module.exports = { sincronizar };

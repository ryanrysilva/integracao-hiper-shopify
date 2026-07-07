// src/services/sync.js
const request = require('../utils/request.js');
const { carregarEstado, salvarEstado } = require('../utils/stateStore.js');
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

// ============================================================
// FUNÇÕES AUXILIARES PARA MAPEAMENTO (conversão de formato)
// ============================================================
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

function mapaParaProdutoExistente(mapaEntry) {
  return {
    id: mapaEntry.shopifyId,
    variants: mapaEntry.variants.map(v => ({
      id: v.variantId,
      sku: v.sku,
      inventory_item_id: v.inventoryItemId,
      title: v.sku || 'Variant'
    }))
  };
}

// ============================================================
// FALLBACK: BUSCA POR METAFIELD (SÓ PARA PRODUTOS NÃO MAPEADOS)
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

  // 1. CARREGA ESTADO DO UPSTASH (persistente entre deploys/restarts)
  let ESTADO = await carregarEstado();

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

    // 2. ATUALIZA MAPA SKU (cumulativo, usado para pedidos)
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

        // 3. VERIFICA SE O PRODUTO JÁ ESTÁ NO MAPA (produtosMap)
        const mapaEntry = ESTADO.produtosMap[produto.id];

        if (mapaEntry) {
          // ✅ Já mapeado → atualiza diretamente pelo Shopify ID
          console.log(`📦 Produto "${produto.nome}" já mapeado (Shopify ID: ${mapaEntry.shopifyId}). Atualizando...`);
          const produtoExistente = mapaParaProdutoExistente(mapaEntry);
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente);
          if (atualizado) {
            ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
            atualizados++;
          }
        } else {
          // 4. NÃO ESTÁ NO MAPA → tenta fallback (metafield ou SKU)
          let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
          if (!existe) {
            existe = await buscarProdutoPorSKU(tokenShopify, sku);
          }

          if (existe) {
            // Encontrou via fallback → atualiza e adiciona ao mapa
            console.log(`📦 Produto "${produto.nome}" encontrado via busca (SKU: ${sku}). Atualizando e mapeando...`);
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
              atualizados++;
            }
          } else {
            // Não encontrou → cria novo
            console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(novo);
              criados++;
            }
          }
        }

        // 5. SALVA NO UPSTASH A CADA PRODUTO (progresso parcial)
        await salvarEstado(ESTADO);

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
      await sleep(400);
    }

    // 6. ATUALIZA PONTO DE SINCRONIZAÇÃO
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

    // 7. SALVA ESTADO FINAL (antes dos pedidos)
    await salvarEstado(ESTADO);

    // --- PEDIDOS (usando mapaSkuHiper persistente) ---
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

    // 8. SALVA ESTADO FINAL
    await salvarEstado(ESTADO);
    console.log(`\n✅ ESTADO SALVO NO UPSTASH (${Object.keys(ESTADO.produtosMap).length} produtos mapeados).`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    // Tenta salvar o que deu mesmo em erro
    await salvarEstado(ESTADO).catch(() => {});
  }
}

module.exports = { sincronizar };

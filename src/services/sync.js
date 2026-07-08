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
// FUNÇÕES AUXILIARES PARA MAPEAMENTO
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
// FALLBACK: BUSCA POR METAFIELD
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

  let ESTADO = await carregarEstado();
  if (ESTADO.falhasPonto === undefined) ESTADO.falhasPonto = 0;

  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    let produtos = [];
    let ponto = 0;
    let pontoOriginal = ESTADO.pontoDeSincronizacao || 0;
    let forcarCompleta = false;

    // ============================================================
    // 1. BUSCA INTELIGENTE COM FALLBACK
    // ============================================================
    try {
      const resposta = await buscarProdutosHiper(tokenHiper, pontoOriginal);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;

      if (!ponto && produtos.length > 0) {
        ponto = pontoOriginal + produtos.length;
      }

      if (produtos.length === 0 && pontoOriginal !== 0) {
        ESTADO.falhasPonto = (ESTADO.falhasPonto || 0) + 1;
        console.warn(`⚠️ Ponto ${pontoOriginal} retornou 0 produtos. Falhas: ${ESTADO.falhasPonto}/3`);

        if (ESTADO.falhasPonto >= 3) {
          console.warn(`🔄 Forçando sincronização completa (ponto=0) após 3 falhas consecutivas.`);
          forcarCompleta = true;
        } else {
          console.log(`⏳ Tentativa ${ESTADO.falhasPonto}/3. Aguardando próxima execução.`);
          await salvarEstado(ESTADO);
          return;
        }
      } else {
        ESTADO.falhasPonto = 0;
      }
    } catch (erro) {
      ESTADO.falhasPonto = (ESTADO.falhasPonto || 0) + 1;
      console.error(`❌ Erro ao buscar produtos: ${erro.message}. Falhas: ${ESTADO.falhasPonto}/3`);

      if (ESTADO.falhasPonto >= 3) {
        console.warn(`🔄 Forçando sincronização completa (ponto=0) após 3 erros consecutivos.`);
        forcarCompleta = true;
      } else {
        await salvarEstado(ESTADO);
        return;
      }
    }

    if (forcarCompleta) {
      console.log(`🔄 Buscando todos os produtos (ponto=0)...`);
      const resposta = await buscarProdutosHiper(tokenHiper, 0);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
      if (!ponto && produtos.length > 0) {
        ponto = produtos.length; // calcula próximo ponto
      }
      ESTADO.falhasPonto = 0;
    }

    if (produtos.length === 0) {
      console.warn('⚠️ Nenhum produto encontrado no Hiper. Verifique a integração.');
      await salvarEstado(ESTADO);
      return;
    }

    console.log(`✅ ${produtos.length} produtos encontrados no Hiper.`);

    // ============================================================
    // 2. ATUALIZA MAPA SKU
    // ============================================================
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => { if (v.codigoDeBarras) ESTADO.mapaSkuHiper[v.codigoDeBarras] = v.id; });
      } else {
        if (produto.codigoDeBarras) ESTADO.mapaSkuHiper[produto.codigoDeBarras] = produto.id;
      }
    }
    const mapaSkuHiper = ESTADO.mapaSkuHiper;

    // ============================================================
    // 3. IDENTIFICAR PRODUTOS ATIVOS (para arquivamento)
    // ============================================================
    const idsAtivos = new Set();
    for (const produto of produtos) {
      if (!produto.removido && produto.ativo) {
        idsAtivos.add(produto.id);
      }
    }

    // ============================================================
    // 4. ARQUIVAR PRODUTOS QUE NÃO ESTÃO MAIS NO HIPER
    // ============================================================
    let arquivados = 0;
    const mapaAtual = { ...ESTADO.produtosMap };
    for (const [hiperId, mapaEntry] of Object.entries(mapaAtual)) {
      if (!idsAtivos.has(hiperId)) {
        try {
          console.log(`🗑️ Produto ${hiperId} não está mais ativo no Hiper. Arquivando na Shopify...`);
          const shopifyId = mapaEntry.shopifyId;
          await arquivarProdutoShopify(tokenShopify, shopifyId);
          delete ESTADO.produtosMap[hiperId];
          arquivados++;
        } catch (erro) {
          console.error(`❌ Erro ao arquivar produto ${hiperId}:`, erro.message);
        }
        await sleep(300);
      }
    }

    // ============================================================
    // 5. CRIAR/ATUALIZAR PRODUTOS ATIVOS
    // ============================================================
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

        const mapaEntry = ESTADO.produtosMap[produto.id];

        if (mapaEntry) {
          console.log(`📦 Produto "${produto.nome}" já mapeado (Shopify ID: ${mapaEntry.shopifyId}). Atualizando...`);
          const produtoExistente = mapaParaProdutoExistente(mapaEntry);
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente);
          if (atualizado) {
            ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
            atualizados++;
          }
        } else {
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

        await salvarEstado(ESTADO);
      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
      await sleep(400);
    }

    // ============================================================
    // 6. ATUALIZA PONTO DE SINCRONIZAÇÃO (CORRIGIDO)
    // ============================================================
    if (produtos.length > 0) {
      let novoPonto = ponto;
      // Se foi sync completa (ponto=0), calculamos o próximo ponto como total de produtos ativos
      if (forcarCompleta || pontoOriginal === 0) {
        // O ponto deve ser o número de produtos processados (offset)
        novoPonto = idsAtivos.size; // ou produtos.length, mas idsAtivos pode ser menor se houver inativos
        // Mas atenção: o ponto normalmente é um offset que começa em 0 e vai incrementando.
        // Se começamos do 0 e processamos N produtos, o próximo ponto é N.
        // Vamos usar produtos.length, que é o total retornado (incluindo inativos? 
        // A API retorna todos, então produtos.length é o número total retornado.
        // Para simplificar, usamos produtos.length.
        novoPonto = produtos.length;
        console.log(`📌 Sincronização completa: calculando novo ponto como ${novoPonto} (${produtos.length} produtos retornados).`);
      } else if (ponto && !isNaN(ponto) && ponto >= 0) {
        novoPonto = ponto;
      } else {
        novoPonto = ESTADO.pontoDeSincronizacao;
      }

      // Garantir que o novo ponto seja maior que o antigo (evitar retrocessos)
      if (novoPonto > ESTADO.pontoDeSincronizacao) {
        ESTADO.pontoDeSincronizacao = novoPonto;
        console.log(`📌 Ponto de sincronização atualizado para ${novoPonto}`);
      } else {
        console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) mantido.`);
      }
    } else {
      console.log(`📌 Nenhum produto processado. Ponto NÃO alterado.`);
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);
    console.log(`🗑️ ${arquivados} produtos ARQUIVADOS (removidos do Hiper).`);

    // ============================================================
    // 7. SALVA ESTADO (antes dos pedidos)
    // ============================================================
    await salvarEstado(ESTADO);

    // ============================================================
    // 8. PEDIDOS
    // ============================================================
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

    await salvarEstado(ESTADO);
    console.log(`\n✅ ESTADO SALVO NO UPSTASH (${Object.keys(ESTADO.produtosMap).length} produtos mapeados).`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    await salvarEstado(ESTADO).catch(() => {});
  }
}

module.exports = { sincronizar };

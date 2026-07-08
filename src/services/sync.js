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
// FUNÇÃO PRINCIPAL DE SINCRONIZAÇÃO (COM FALLBACK INTELIGENTE)
// ============================================================
async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');

  // 1. CARREGA ESTADO DO UPSTASH
  let ESTADO = await carregarEstado();

  // 2. INICIALIZA CONTADOR DE FALHAS (se não existir)
  if (ESTADO.falhasPonto === undefined) ESTADO.falhasPonto = 0;

  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    let produtos = [];
    let ponto = 0;
    let pontoOriginal = ESTADO.pontoDeSincronizacao || 0;
    let forcarCompleta = false;

    // ============================================================
    // 3. BUSCA INTELIGENTE COM FALLBACK E CONTADOR DE FALHAS
    // ============================================================
    try {
      const resposta = await buscarProdutosHiper(tokenHiper, pontoOriginal);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao; // Próximo ponto (se retornado)
      
      // Se a API não retornar um próximo ponto, calculamos baseado no tamanho
      if (!ponto && produtos.length > 0) {
        ponto = pontoOriginal + produtos.length;
      }
      
      // Verifica se o ponto retornou produtos
      if (produtos.length === 0 && pontoOriginal !== 0) {
        // Ponto atual não retornou produtos → incrementa contador de falhas
        ESTADO.falhasPonto = (ESTADO.falhasPonto || 0) + 1;
        console.warn(`⚠️ Ponto ${pontoOriginal} retornou 0 produtos. Falhas: ${ESTADO.falhasPonto}/3`);
        
        if (ESTADO.falhasPonto >= 3) {
          console.warn(`🔄 Forçando sincronização completa (ponto=0) após 3 falhas consecutivas.`);
          forcarCompleta = true;
        } else {
          // Apenas loga e encerra (na próxima execução tentará novamente)
          console.log(`⏳ Tentativa ${ESTADO.falhasPonto}/3. Aguardando próxima execução.`);
          await salvarEstado(ESTADO);
          return;
        }
      } else {
        // Sucesso: reseta contador
        ESTADO.falhasPonto = 0;
      }
    } catch (erro) {
      // Erro de rede/API também conta como falha
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

    // 4. SE FORÇAR COMPLETA, BUSCA COM PONTO=0
    if (forcarCompleta) {
      console.log(`🔄 Buscando todos os produtos (ponto=0)...`);
      const resposta = await buscarProdutosHiper(tokenHiper, 0);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
      if (!ponto && produtos.length > 0) {
        ponto = produtos.length; // ou outro cálculo
      }
      // Reseta contador após a sync completa
      ESTADO.falhasPonto = 0;
    }

    if (produtos.length === 0) {
      console.warn('⚠️ Nenhum produto encontrado no Hiper. Verifique a integração.');
      await salvarEstado(ESTADO);
      return;
    }

    console.log(`✅ ${produtos.length} produtos encontrados no Hiper.`);

    // 5. ATUALIZA MAPA SKU (cumulativo, usado para pedidos)
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

        // Verifica se o produto já está no mapa
        const mapaEntry = ESTADO.produtosMap[produto.id];

        if (mapaEntry) {
          // ✅ Já mapeado → atualiza diretamente
          console.log(`📦 Produto "${produto.nome}" já mapeado (Shopify ID: ${mapaEntry.shopifyId}). Atualizando...`);
          const produtoExistente = mapaParaProdutoExistente(mapaEntry);
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente);
          if (atualizado) {
            ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
            atualizados++;
          }
        } else {
          // 6. NÃO ESTÁ NO MAPA → fallback (metafield ou SKU)
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

        // Salva progresso parcial
        await salvarEstado(ESTADO);

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
      await sleep(400);
    }

    // 7. ATUALIZA PONTO DE SINCRONIZAÇÃO (SEMPRE QUE HOUVER PRODUTOS)
    if (produtos.length > 0) {
      // Se o ponto for válido e maior que o atual, atualiza
      if (ponto && !isNaN(ponto) && ponto >= 0) {
        // Se for sync completa (ponto=0), salvamos o novo ponto
        if (forcarCompleta || pontoOriginal === 0) {
          ESTADO.pontoDeSincronizacao = ponto;
          console.log(`📌 Ponto de sincronização atualizado para ${ponto} (sync completa).`);
        } else if (ponto > ESTADO.pontoDeSincronizacao) {
          ESTADO.pontoDeSincronizacao = ponto;
          console.log(`📌 Ponto de sincronização atualizado para ${ponto}`);
        } else {
          console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) mantido.`);
        }
      } else {
        console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) mantido (sem novo ponto).`);
      }
    } else {
      console.log(`📌 Nenhum produto processado. Ponto NÃO alterado.`);
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);

    // 8. SALVA ESTADO FINAL (antes dos pedidos)
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

    // 9. SALVA ESTADO FINAL
    await salvarEstado(ESTADO);
    console.log(`\n✅ ESTADO SALVO NO UPSTASH (${Object.keys(ESTADO.produtosMap).length} produtos mapeados).`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    // Tenta salvar o que deu mesmo em erro
    await salvarEstado(ESTADO).catch(() => {});
  }
}

module.exports = { sincronizar };

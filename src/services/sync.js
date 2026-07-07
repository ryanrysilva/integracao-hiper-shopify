// src/services/sync.js
const fs = require('fs');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarPedidosShopify
} = require('./shopify.js');

let ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
if (fs.existsSync('state.json')) {
  try {
    ESTADO = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    if (isNaN(ESTADO.pontoDeSincronizacao) || ESTADO.pontoDeSincronizacao < 0) ESTADO.pontoDeSincronizacao = 0;
  } catch (e) {
    console.warn('⚠️ state.json corrompido, resetando...');
    ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
  }
}

// ============================================================
// FUNÇÃO PARA BUSCAR PRODUTO PELO METAFIELD (via GraphQL)
// ============================================================
async function buscarProdutoPorMetafield(token, hiperId) {
  console.log(`🔍 Buscando produto pelo metafield: hiper.product_id = ${hiperId}`);
  const query = `{
    products(first: 1, query: "metafield_namespace:hiper AND metafield_key:product_id AND metafield_value:${hiperId}") {
      edges {
        node {
          id
          title
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    }
  }`;

  const request = require('../utils/request.js');
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
      metafields: product.metafields.edges.map(edge => ({
        namespace: edge.node.namespace,
        key: edge.node.key,
        value: edge.node.value
      }))
    };
  } catch (err) {
    console.error(`❌ Erro ao buscar metafield ${hiperId}:`, err.message);
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

    // Constrói mapa SKU -> ID Hiper (para pedidos)
    const mapaSkuHiper = {};
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => { if (v.codigoDeBarras) mapaSkuHiper[v.codigoDeBarras] = v.id; });
      } else {
        if (produto.codigoDeBarras) mapaSkuHiper[produto.codigoDeBarras] = produto.id;
      }
    }

    let criados = 0;
    let atualizados = 0;
    let arquivados = 0;
    const skusProcessados = new Set();

    // Primeiro: arquiva produtos antigos sem metafield (limpeza)
    console.log('\n🧹 Verificando produtos existentes para evitar duplicatas...');
    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue;
      if (produto.produtoPrimarioId && produto.produtoPrimarioId !== '00000000-0000-0000-0000-000000000000') continue;

      let sku = produto.codigoDeBarras;
      if (!sku && produto.variacao && produto.variacao.length > 0) {
        sku = produto.variacao[0].codigoDeBarras;
      }
      if (!sku) continue;

      try {
        // Busca pelo metafield primeiro
        let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
        if (!existe) {
          // Fallback: busca por SKU
          existe = await buscarProdutoPorSKU(tokenShopify, sku);
        }
        if (existe) {
          const temMetafield = existe.metafields && existe.metafields.some(mf => 
            mf.namespace === 'hiper' && mf.key === 'product_id'
          );
          if (!temMetafield) {
            console.log(`📦 Arquivando produto antigo "${produto.nome}" (SKU: ${sku})...`);
            await arquivarProdutoShopify(tokenShopify, existe.id);
            arquivados++;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      } catch (erro) {
        console.warn(`⚠️ Erro ao verificar produto ${produto.nome}: ${erro.message}`);
      }
    }

    // Segundo: cria ou atualiza produtos
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

        if (skusProcessados.has(sku)) {
          console.log(`⏩ SKU ${sku} já processado. Pulando...`);
          continue;
        }

        // 1. Busca pelo metafield (ID do Hiper)
        let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);

        // 2. Se não encontrou, busca por SKU (fallback)
        if (!existe) {
          existe = await buscarProdutoPorSKU(tokenShopify, sku);
        }

        if (existe) {
          console.log(`📦 Produto "${produto.nome}" encontrado (SKU: ${sku}). Atualizando...`);
          const temMetafield = existe.metafields && existe.metafields.some(mf => 
            mf.namespace === 'hiper' && mf.key === 'product_id'
          );
          if (temMetafield) {
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              atualizados++;
              skusProcessados.add(sku);
            }
          } else {
            console.log(`🔄 Produto "${produto.nome}" sem metafield. Recriando...`);
            await arquivarProdutoShopify(tokenShopify, existe.id);
            await new Promise(resolve => setTimeout(resolve, 500));
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              criados++;
              skusProcessados.add(sku);
            }
          }
        } else {
          console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
          const novo = await criarProdutoShopify(tokenShopify, produto);
          if (novo) {
            criados++;
            skusProcessados.add(sku);
          }
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
    }

    if (produtos.length > 0 && (criados > 0 || atualizados > 0 || arquivados > 0)) {
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
    console.log(`📦 ${arquivados} produtos ARQUIVADOS (antigos).`);

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
      }
    }

    fs.writeFileSync('state.json', JSON.stringify(ESTADO, null, 2));
    console.log(`\n✅ ESTADO SALVO.`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
  }
}

module.exports = { sincronizar };

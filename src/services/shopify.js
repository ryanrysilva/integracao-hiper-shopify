// src/services/shopify.js
const request = require('../utils/request.js');
const CONFIG = require('../config/index.js');

function gerarTokenShopify() {
  console.log('🔄 Gerando token da Shopify...');
  const dados = `grant_type=client_credentials&client_id=${CONFIG.shopify.client_id}&client_secret=${CONFIG.shopify.client_secret}`;
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: '/admin/oauth/access_token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(dados)
    }
  };
  return request(opcoes, dados).then(res => {
    if (!res.access_token) throw new Error('Token Shopify não retornado');
    console.log('✅ Token Shopify gerado com sucesso!');
    return res.access_token;
  });
}

// ============================================================
// BUSCA PRODUTO POR SKU (GRAPHQL – CORRETO)
// ============================================================
function buscarProdutoPorSKU(token, sku) {
  if (!sku) return Promise.resolve(null);
  console.log(`🔍 Buscando produto pelo SKU: ${sku} (via GraphQL)`);

  const query = `{
    productVariants(first: 1, query: "sku:${sku}") {
      edges {
        node {
          id
          sku
          product {
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
    }
  }`;

  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: '/admin/api/2026-07/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };

  return request(opcoes, JSON.stringify({ query }))
    .then(res => {
      if (res.errors) throw new Error(JSON.stringify(res.errors));
      const edges = res.data?.productVariants?.edges || [];
      if (edges.length === 0) return null;
      const variantNode = edges[0].node;
      const product = variantNode.product;
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
    })
    .catch(err => {
      console.error(`❌ Erro ao buscar SKU ${sku}:`, err.message);
      return null;
    });
}

// ============================================================
// ARQUIVAR PRODUTO
// ============================================================
function arquivarProdutoShopify(token, productId) {
  console.log(`📦 Arquivando produto ID ${productId}...`);
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products/${productId}.json`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };
  const payload = { product: { status: 'archived' } };
  return request(opcoes, JSON.stringify(payload)).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`✅ Produto ${productId} arquivado.`);
    return true;
  }).catch((err) => {
    console.warn(`⚠️ Erro ao arquivar produto: ${err.message}`);
    return false;
  });
}

// ============================================================
// CRIAR PRODUTO (COM METAFIELD)
// ============================================================
function criarProdutoShopify(token, produtoHiper) {
  console.log(`🔄 CRIANDO produto "${produtoHiper.nome}" na Shopify...`);
  
  let sku = produtoHiper.codigoDeBarras || `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const hiperId = produtoHiper.id;

  const produtoShopify = {
    product: {
      title: produtoHiper.nome,
      body_html: produtoHiper.descricao || '',
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      options: [],
      variants: [],
      metafields: [
        {
          namespace: 'hiper',
          key: 'product_id',
          value: hiperId,
          type: 'single_line_text_field'
        }
      ]
    }
  };

  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    console.log(`🔁 Criando produto com ${produtoHiper.variacao.length} variações.`);
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
    const opcoes = [{ name: tipoVariacaoA }];
    if (tipoVariacaoB) opcoes.push({ name: tipoVariacaoB });
    produtoShopify.product.options = opcoes;

    produtoHiper.variacao.forEach(variacao => {
      const varSku = variacao.codigoDeBarras || sku;
      const variant = {
        sku: varSku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(variacao.quantidadeEmEstoque || 0)
      };
      variant.option1 = variacao.nomeVariacaoA || 'Padrão';
      if (tipoVariacaoB) {
        variant.option2 = variacao.nomeVariacaoB || 'Padrão';
      }
      produtoShopify.product.variants.push(variant);
    });

  } else {
    produtoShopify.product.options = [{ name: 'Título' }];
    produtoShopify.product.variants.push({
      sku: sku,
      price: produtoHiper.preco.toString(),
      inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0),
      option1: produtoHiper.nome
    });
  }

  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: '/admin/api/2026-07/products.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };
  return request(opcoes, JSON.stringify(produtoShopify)).then(res => {
    if (res.errors) {
      console.error(`❌ Falha ao criar "${produtoHiper.nome}": ${JSON.stringify(res.errors)}`);
      throw new Error(JSON.stringify(res.errors));
    }
    console.log(`✅ Produto "${produtoHiper.nome}" CRIADO na Shopify! ID: ${res.product.id}`);
    return res.product;
  });
}

// ============================================================
// ATUALIZAR ESTOQUE (VIA INVENTORY API)
// ============================================================
function atualizarEstoqueShopify(token, inventoryItemId, quantity, locationId = null) {
  if (!inventoryItemId) {
    console.warn('⚠️ inventoryItemId não informado. Pulando atualização de estoque.');
    return Promise.resolve();
  }
  const buscaLocation = locationId ? Promise.resolve({ locations: [{ id: locationId }] }) :
    request({
      hostname: `${CONFIG.shopify.loja}.myshopify.com`,
      path: '/admin/api/2026-07/locations.json',
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token }
    });

  return buscaLocation.then(res => {
    if (!res.locations || res.locations.length === 0) {
      throw new Error('Nenhum location encontrado');
    }
    const locId = locationId || res.locations[0].id;
    const opcoes = {
      hostname: `${CONFIG.shopify.loja}.myshopify.com`,
      path: '/admin/api/2026-07/inventory_levels/set.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      }
    };
    const payload = {
      location_id: locId,
      inventory_item_id: inventoryItemId,
      available: Math.max(0, quantity)
    };
    return request(opcoes, JSON.stringify(payload)).then(res => {
      if (res.errors) throw new Error(JSON.stringify(res.errors));
      console.log(`✅ Estoque do inventory_item ${inventoryItemId} atualizado para ${quantity}`);
      return res;
    });
  });
}

// ============================================================
// ATUALIZAR PRODUTO (PREÇO, OPÇÕES, E ESTOQUE VIA API SEPARADA)
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (preço e opções)...`);
  if (!produtoExistente || !produtoExistente.variants || produtoExistente.variants.length === 0) {
    console.error(`❌ Produto "${produtoHiper.nome}" não tem variantes válidas.`);
    return null;
  }

  const defaultVariant = produtoExistente.variants.find(v => v.title === 'Default Title');
  if (defaultVariant) {
    console.log(`🔁 Excluindo "Default Title" (ID: ${defaultVariant.id})...`);
    try {
      const opcoes = {
        hostname: `${CONFIG.shopify.loja}.myshopify.com`,
        path: `/admin/api/2026-07/variants/${defaultVariant.id}.json`,
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': token }
      };
      await request(opcoes);
      console.log(`✅ "Default Title" excluída.`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const recarregado = await buscarProdutoPorSKU(token, produtoHiper.codigoDeBarras || produtoHiper.variacao?.[0]?.codigoDeBarras);
      if (recarregado) produtoExistente = recarregado;
    } catch (erro) {
      console.warn(`⚠️ Erro ao excluir Default Title: ${erro.message}. Continuando...`);
    }
  }

  const temVariacoes = produtoHiper.variacao && produtoHiper.variacao.length > 0;
  const sku = produtoHiper.codigoDeBarras || (temVariacoes ? produtoHiper.variacao[0].codigoDeBarras : '');
  const mapaExistente = {};
  produtoExistente.variants.forEach(v => { mapaExistente[v.sku] = v; });

  let variantsAtualizados = [];
  if (temVariacoes) {
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
    for (const variacaoHiper of produtoHiper.variacao) {
      const varSku = variacaoHiper.codigoDeBarras || '';
      const existente = mapaExistente[varSku];
      const variant = { sku: varSku, price: produtoHiper.preco.toString(), option1: variacaoHiper.nomeVariacaoA || 'Padrão' };
      if (tipoVariacaoB) variant.option2 = variacaoHiper.nomeVariacaoB || 'Padrão';
      if (existente) {
        variant.id = existente.id;
        if (existente.inventory_item_id) {
          await atualizarEstoqueShopify(token, existente.inventory_item_id, Math.floor(variacaoHiper.quantidadeEmEstoque || 0))
            .catch(err => console.warn(`⚠️ Erro ao atualizar estoque da variante ${existente.id}: ${err.message}`));
        }
      } else {
        variant.inventory_quantity = Math.floor(variacaoHiper.quantidadeEmEstoque || 0);
      }
      variantsAtualizados.push(variant);
    }
  } else {
    const existente = mapaExistente[sku];
    const variant = { sku: sku, price: produtoHiper.preco.toString(), option1: produtoHiper.nome };
    if (existente) {
      variant.id = existente.id;
      if (existente.inventory_item_id) {
        await atualizarEstoqueShopify(token, existente.inventory_item_id, Math.floor(produtoHiper.quantidadeEmEstoque || 0))
          .catch(err => console.warn(`⚠️ Erro ao atualizar estoque da variante ${existente.id}: ${err.message}`));
      }
    } else {
      variant.inventory_quantity = Math.floor(produtoHiper.quantidadeEmEstoque || 0);
    }
    variantsAtualizados.push(variant);
  }

  const atualizacao = {
    product: {
      id: produtoExistente.id,
      title: produtoHiper.nome,
      body_html: produtoHiper.descricao || '',
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      variants: variantsAtualizados
    }
  };
  if (temVariacoes) {
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
    const opcoes = [{ name: tipoVariacaoA }];
    if (tipoVariacaoB) opcoes.push({ name: tipoVariacaoB });
    atualizacao.product.options = opcoes;
  } else {
    atualizacao.product.options = [{ name: 'Título' }];
  }

  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products/${produtoExistente.id}.json`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };
  try {
    const res = await request(opcoes, JSON.stringify(atualizacao));
    if (res.errors) {
      console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${JSON.stringify(res.errors)}`);
      return null;
    }
    console.log(`✅ Produto "${produtoHiper.nome}" ATUALIZADO (preço e opções) na Shopify!`);
    return res.product;
  } catch (erro) {
    console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${erro.message}`);
    return null;
  }
}

// ============================================================
// BUSCAR PEDIDOS
// ============================================================
function buscarPedidosShopify(token, sinceId = 0) {
  console.log(`🔄 Buscando pedidos novos na Shopify (since_id: ${sinceId})...`);
  const path = `/admin/api/2026-07/orders.json?status=any&since_id=${sinceId}&limit=50`;
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: path,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`✅ ${res.orders?.length || 0} pedidos novos encontrados.`);
    return res.orders || [];
  });
}

// ============================================================
// EXPORTAÇÕES
// ============================================================
module.exports = {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarPedidosShopify
};

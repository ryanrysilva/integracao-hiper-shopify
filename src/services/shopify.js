// src/services/shopify.js
const request = require('../utils/request.js');
const CONFIG = require('../config/index.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
// BUSCA PRODUTO POR SKU (GRAPHQL)
// ============================================================
function buscarProdutoPorSKU(token, sku) {
  if (!sku) return Promise.resolve(null);
  console.log(`🔍 Buscando produto pelo SKU: ${sku} (via GraphQL)`);
  const query = `{
    productVariants(first: 1, query: "sku:'${sku}'") {
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
// MONTA A LISTA DE IMAGENS NO FORMATO DA API DE PRODUTOS
// ============================================================
function montarImagensShopify(produtoHiper) {
  const imagens = [];
  if (produtoHiper.imagem) imagens.push({ src: produtoHiper.imagem });
  if (Array.isArray(produtoHiper.imagensAdicionais)) {
    produtoHiper.imagensAdicionais.forEach(img => {
      const url = (img && typeof img === 'object') ? img.imagem : img;
      if (url) imagens.push({ src: url });
    });
  }
  return imagens;
}

// ============================================================
// CRIAR PRODUTO (COM METAFIELD E IMAGENS)
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

  const imagens = montarImagensShopify(produtoHiper);
  if (imagens.length > 0) produtoShopify.product.images = imagens;

  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    console.log(`🔁 Criando produto com ${produtoHiper.variacao.length} variações.`);
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
    const opcoesVariacao = [{ name: tipoVariacaoA }];
    if (tipoVariacaoB) opcoesVariacao.push({ name: tipoVariacaoB });
    produtoShopify.product.options = opcoesVariacao;
    produtoHiper.variacao.forEach((variacao, idx) => {
      const varSku = variacao.codigoDeBarras || `${sku}-V${idx + 1}`;
      const variant = {
        sku: varSku,
        price: produtoHiper.preco.toString(),
        inventory_management: 'shopify',
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
      inventory_management: 'shopify',
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
// BUSCA OS DADOS ATUAIS DE UM PRODUTO NA SHOPIFY
// ------------------------------------------------------------
// Usado antes de atualizar, pra decidir se a descrição/imagens
// foram editadas manualmente e não devem ser sobrescritas.
// ============================================================
function buscarDadosAtuaisProdutoShopify(token, productId) {
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products/${productId}.json?fields=body_html,images`,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    return {
      body_html: res.product?.body_html || '',
      images: res.product?.images || []
    };
  });
}

// ============================================================
// CACHE DE LOCATION + ATUALIZAR ESTOQUE
// ============================================================
let _locationIdCache = null;
async function obterLocationId(token) {
  if (_locationIdCache) return _locationIdCache;
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: '/admin/api/2026-07/locations.json',
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  const res = await request(opcoes);
  if (res.errors) {
    throw new Error(`Erro ao buscar locations: ${JSON.stringify(res.errors)}`);
  }
  if (!res.locations || res.locations.length === 0) {
    throw new Error('Nenhum location retornado pela Shopify. Verifique se o app tem o scope "read_locations" habilitado.');
  }
  _locationIdCache = res.locations[0].id;
  console.log(`📍 Location detectado e cacheado: ${_locationIdCache}`);
  return _locationIdCache;
}

async function atualizarEstoqueShopify(token, inventoryItemId, quantity, locationId = null) {
  if (!inventoryItemId) {
    console.warn('⚠️ inventoryItemId não informado. Pulando atualização de estoque.');
    return;
  }
  const locId = locationId || await obterLocationId(token);
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
  const res = await request(opcoes, JSON.stringify(payload));
  if (res.errors) throw new Error(JSON.stringify(res.errors));
  console.log(`✅ Estoque do inventory_item ${inventoryItemId} atualizado para ${quantity}`);
  return res;
}

// ============================================================
// ATUALIZAR PRODUTO (PREÇO, OPÇÕES, IMAGENS E ESTOQUE)
// ------------------------------------------------------------
// opcoesSync:
//   preservarDescricao — se true, NÃO inclui body_html no payload
//   (mantém o que já está na Shopify, mesmo que o Hiper tenha uma
//   descrição diferente — usado quando detectamos edição manual).
//   preservarImagens — mesma ideia, mas pra images.
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente, opcoesSync = {}) {
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
      await sleep(1000);
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
    for (let idx = 0; idx < produtoHiper.variacao.length; idx++) {
      const variacaoHiper = produtoHiper.variacao[idx];
      const varSku = variacaoHiper.codigoDeBarras || `${sku}-V${idx + 1}`;
      const existente = mapaExistente[varSku];
      const variant = { sku: varSku, price: produtoHiper.preco.toString(), option1: variacaoHiper.nomeVariacaoA || 'Padrão', inventory_management: 'shopify' };
      if (tipoVariacaoB) variant.option2 = variacaoHiper.nomeVariacaoB || 'Padrão';
      if (existente) {
        variant.id = existente.id;
        if (existente.inventory_item_id) {
          await atualizarEstoqueShopify(token, existente.inventory_item_id, Math.floor(variacaoHiper.quantidadeEmEstoque || 0))
            .catch(err => console.warn(`⚠️ Erro ao atualizar estoque da variante ${existente.id}: ${err.message}`));
          await sleep(300);
        }
      } else {
        variant.inventory_quantity = Math.floor(variacaoHiper.quantidadeEmEstoque || 0);
      }
      variantsAtualizados.push(variant);
    }
  } else {
    const existente = mapaExistente[sku];
    const variant = { sku: sku, price: produtoHiper.preco.toString(), option1: produtoHiper.nome, inventory_management: 'shopify' };
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
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      variants: variantsAtualizados
    }
  };

  if (!opcoesSync.preservarDescricao) {
    atualizacao.product.body_html = produtoHiper.descricao || '';
  }
  if (!opcoesSync.preservarImagens) {
    const imagens = montarImagensShopify(produtoHiper);
    if (imagens.length > 0) atualizacao.product.images = imagens;
  }

  if (temVariacoes) {
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
    const opcoesVariacao = [{ name: tipoVariacaoA }];
    if (tipoVariacaoB) opcoesVariacao.push({ name: tipoVariacaoB });
    atualizacao.product.options = opcoesVariacao;
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
// BUSCA O CPF/CNPJ DE UM PEDIDO (CAMPO NATIVO DO CHECKOUT BR)
// ------------------------------------------------------------
// Quando o CPF/CNPJ é coletado pela configuração nativa da Shopify
// (Configurações > Finalização de compra > Brasil), esse valor
// NÃO aparece na API REST de pedidos — só é exposto via GraphQL,
// dentro de "localizationExtensions". Por isso essa busca é
// separada da REST e feita sob demanda por pedido.
// ============================================================
function buscarCpfCnpjDoPedido(token, orderId) {
  const query = `{
    order(id: "gid://shopify/Order/${orderId}") {
      localizationExtensions(first: 10) {
        edges {
          node {
            countryCode
            purpose
            title
            value
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
  return request(opcoes, JSON.stringify({ query })).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    const edges = res.data?.order?.localizationExtensions?.edges || [];
    const campo = edges.find(e => {
      const n = e.node;
      return n.title === 'CPF/CNPJ'
        || n.purpose === 'TAX'
        || n.purpose === 'TAX_CREDENTIAL_BR'
        || n.purpose === 'SHIPPING_CREDENTIAL_BR';
    });
    return campo ? (campo.node.value || '').replace(/\D/g, '') : null;
  }).catch(err => {
    console.warn(`⚠️ Erro ao buscar CPF/CNPJ do pedido ${orderId} via GraphQL: ${err.message}`);
    return null;
  });
}

// ============================================================
// BUSCA UM PEDIDO ESPECÍFICO POR ID (usado no retry de pedidos
// que falharam ao enviar pro Hiper)
// ============================================================
function buscarPedidoPorIdShopify(token, orderId) {
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/orders/${orderId}.json`,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    return res.order || null;
  }).catch(err => {
    console.warn(`⚠️ Erro ao buscar pedido ${orderId} na Shopify: ${err.message}`);
    return null;
  });
}

// ============================================================
// BUSCAR PEDIDOS NOVOS
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
// BUSCAR PEDIDOS CANCELADOS (pra propagar cancelamento ao Hiper)
// ============================================================
function buscarPedidosCanceladosShopify(token, desdeISO) {
  console.log(`🔄 Buscando pedidos cancelados na Shopify desde ${desdeISO}...`);
  const path = `/admin/api/2026-07/orders.json?status=cancelled&updated_at_min=${encodeURIComponent(desdeISO)}&limit=250`;
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`✅ ${res.orders?.length || 0} pedidos cancelados encontrados.`);
    return res.orders || [];
  });
}

// ============================================================
// ADICIONA UMA TAG A UM PEDIDO (status vindo do Hiper: faturado,
// cancelado no Hiper, etc.) — sem apagar as tags que já existem.
// ============================================================
async function adicionarTagAoPedidoShopify(token, orderId, novaTag) {
  try {
    const opcoesGet = {
      hostname: `${CONFIG.shopify.loja}.myshopify.com`,
      path: `/admin/api/2026-07/orders/${orderId}.json?fields=tags`,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token }
    };
    const atual = await request(opcoesGet);
    if (atual.errors) throw new Error(JSON.stringify(atual.errors));

    const tagsAtuais = (atual.order?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (tagsAtuais.includes(novaTag)) return true; // já tem a tag

    tagsAtuais.push(novaTag);
    const opcoesPut = {
      hostname: `${CONFIG.shopify.loja}.myshopify.com`,
      path: `/admin/api/2026-07/orders/${orderId}.json`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      }
    };
    const res = await request(opcoesPut, JSON.stringify({ order: { id: orderId, tags: tagsAtuais.join(', ') } }));
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`🏷️ Tag "${novaTag}" adicionada ao pedido ${orderId}.`);
    return true;
  } catch (err) {
    console.warn(`⚠️ Erro ao adicionar tag "${novaTag}" ao pedido ${orderId}: ${err.message}`);
    return false;
  }
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
  buscarDadosAtuaisProdutoShopify,
  buscarCpfCnpjDoPedido,
  buscarPedidosShopify,
  buscarPedidoPorIdShopify,
  buscarPedidosCanceladosShopify,
  adicionarTagAoPedidoShopify,
  sleep
};

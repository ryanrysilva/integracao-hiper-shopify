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

function buscarProdutoNaShopifyPorSKU(token, sku) {
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products.json?sku=${encodeURIComponent(sku)}`,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    return res.products && res.products.length > 0 ? res.products[0] : null;
  });
}

function criarProdutoShopify(token, produtoHiper) {
  console.log(`🔄 CRIANDO produto "${produtoHiper.nome}" na Shopify...`);
  let sku = produtoHiper.codigoDeBarras || '';
  if (!sku) sku = `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const produtoShopify = {
    product: {
      title: produtoHiper.nome,
      body_html: produtoHiper.descricao || '',
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      variants: []
    }
  };

  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    produtoHiper.variacao.forEach(variacao => {
      const varSku = variacao.codigoDeBarras || sku;
      produtoShopify.product.variants.push({
        title: variacao.nomeVariacaoA + (variacao.nomeVariacaoB ? ' / ' + variacao.nomeVariacaoB : ''),
        price: produtoHiper.preco.toString(),
        sku: varSku,
        inventory_quantity: Math.floor(variacao.quantidadeEmEstoque || 0)
      });
    });
  } else {
    produtoShopify.product.variants.push({
      title: produtoHiper.nome,
      price: produtoHiper.preco.toString(),
      sku: sku,
      inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0)
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
      console.warn(`⚠️ Falha ao criar com título, tentando sem...`);
      produtoShopify.product.variants = [{
        price: produtoHiper.preco.toString(),
        sku: sku,
        inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0)
      }];
      return request(opcoes, JSON.stringify(produtoShopify)).then(res2 => {
        if (res2.errors) throw new Error(JSON.stringify(res2.errors));
        console.log(`✅ Produto "${produtoHiper.nome}" CRIADO na Shopify (sem título)! ID: ${res2.product.id}`);
        return res2.product;
      });
    }
    console.log(`✅ Produto "${produtoHiper.nome}" CRIADO na Shopify! ID: ${res.product.id}`);
    return res.product;
  });
}

// ============================================================
// FUNÇÃO PARA EXCLUIR UMA VARIANTE POR ID
// ============================================================
function excluirVarianteShopify(token, variantId) {
  console.log(`🗑️ Excluindo variante ID ${variantId}...`);
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/variants/${variantId}.json`,
    method: 'DELETE',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(() => {
    console.log(`✅ Variante ${variantId} excluída.`);
    return true;
  }).catch((err) => {
    console.warn(`⚠️ Erro ao excluir variante: ${err.message}`);
    return false;
  });
}

// ============================================================
// FUNÇÃO ATUALIZAR PRODUTO (COM EXCLUSÃO DA DEFAULT TITLE)
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (preço e estoque)...`);

  const temVariacoes = produtoHiper.variacao && produtoHiper.variacao.length > 0;

  // Mapeia variantes existentes na Shopify por SKU
  const mapaExistente = {};
  produtoExistente.variants.forEach(v => { mapaExistente[v.sku] = v; });

  // Identifica a variante "Default Title" (sem SKU)
  const defaultVariant = produtoExistente.variants.find(v => v.title === 'Default Title' && !v.sku);

  // Se existir "Default Title", exclui ela primeiro
  if (defaultVariant) {
    console.log(`🔁 Excluindo "Default Title" (ID: ${defaultVariant.id}) para substituir pelas variações do Hiper.`);
    await excluirVarianteShopify(token, defaultVariant.id);
    // Aguarda 1 segundo para garantir que a exclusão foi processada
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Recarrega o produto atualizado após a exclusão
    const sku = produtoHiper.codigoDeBarras || 
                (produtoHiper.variacao && produtoHiper.variacao.length > 0 ? produtoHiper.variacao[0].codigoDeBarras : '');
    if (sku) {
      const produtoAtualizado = await buscarProdutoNaShopifyPorSKU(token, sku);
      if (produtoAtualizado) {
        produtoExistente = produtoAtualizado;
        // Atualiza o mapa com as variantes restantes
        const novoMapa = {};
        produtoExistente.variants.forEach(v => { novoMapa[v.sku] = v; });
        Object.assign(mapaExistente, novoMapa);
      }
    }
  }

  // Se o produto tem variações no Hiper, cria/atualiza todas
  let variantsAtualizados = [];

  if (temVariacoes) {
    console.log(`🔁 Produto com ${produtoHiper.variacao.length} variações no Hiper.`);
    produtoHiper.variacao.forEach(variacaoHiper => {
      const varSku = variacaoHiper.codigoDeBarras || '';
      const existente = mapaExistente[varSku];
      if (existente) {
        variantsAtualizados.push({
          id: existente.id,
          sku: varSku,
          price: produtoHiper.preco.toString(),
          inventory_quantity: Math.floor(variacaoHiper.quantidadeEmEstoque || 0)
        });
      } else {
        variantsAtualizados.push({
          sku: varSku,
          price: produtoHiper.preco.toString(),
          inventory_quantity: Math.floor(variacaoHiper.quantidadeEmEstoque || 0)
        });
      }
    });
  } else {
    // Produto SEM variações no Hiper
    const sku = produtoHiper.codigoDeBarras || '';
    const existente = mapaExistente[sku];
    if (existente) {
      variantsAtualizados.push({
        id: existente.id,
        sku: sku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0)
      });
    } else {
      variantsAtualizados.push({
        sku: sku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0)
      });
    }
  }

  // Monta a atualização
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
    console.log(`✅ Produto "${produtoHiper.nome}" ATUALIZADO (preço/estoque) na Shopify!`);
    return res.product;
  } catch (erro) {
    console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${erro.message}`);
    return null;
  }
}

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

module.exports = {
  gerarTokenShopify,
  buscarProdutoNaShopifyPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  buscarPedidosShopify
};

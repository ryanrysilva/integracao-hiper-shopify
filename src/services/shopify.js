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

function excluirProdutoShopify(token, productId) {
  console.log(`🗑️ Excluindo produto ID ${productId}...`);
  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products/${productId}.json`,
    method: 'DELETE',
    headers: { 'X-Shopify-Access-Token': token }
  };
  return request(opcoes).then(() => {
    console.log(`✅ Produto ${productId} excluído.`);
    return true;
  }).catch((err) => {
    console.warn(`⚠️ Erro ao excluir produto: ${err.message}`);
    return false;
  });
}

// ============================================================
// FUNÇÃO CRIAR PRODUTO (CORRIGIDA – ESTRUTURA DE VARIANTES)
// ============================================================
function criarProdutoShopify(token, produtoHiper) {
  console.log(`🔄 CRIANDO produto "${produtoHiper.nome}" na Shopify...`);
  
  // SKU principal (fallback)
  let sku = produtoHiper.codigoDeBarras || `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  // Estrutura base do produto
  const produtoShopify = {
    product: {
      title: produtoHiper.nome,
      body_html: produtoHiper.descricao || '',
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      options: [], // Será preenchido com os nomes das opções
      variants: []
    }
  };

  // Se tem variações, estrutura as opções e variantes
  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    console.log(`🔁 Criando produto com ${produtoHiper.variacao.length} variações.`);

    // Extrai os tipos de variação (ex: "Cor", "Tamanho")
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;

    // Define as opções do produto
    const opcoes = [tipoVariacaoA];
    if (tipoVariacaoB) opcoes.push(tipoVariacaoB);
    produtoShopify.product.options = opcoes;

    // Cria cada variante
    produtoHiper.variacao.forEach(variacao => {
      const varSku = variacao.codigoDeBarras || sku;
      const variant = {
        sku: varSku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(variacao.quantidadeEmEstoque || 0)
      };

      // Define as opções (option1, option2)
      variant.option1 = variacao.nomeVariacaoA || 'Padrão';
      if (tipoVariacaoB) {
        variant.option2 = variacao.nomeVariacaoB || 'Padrão';
      }

      produtoShopify.product.variants.push(variant);
    });

  } else {
    // Produto sem variações
    produtoShopify.product.options = ['Título'];
    produtoShopify.product.variants.push({
      sku: sku,
      price: produtoHiper.preco.toString(),
      inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0),
      option1: produtoHiper.nome
    });
  }

  // Envia para a Shopify
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
// FUNÇÃO DE DIAGNÓSTICO
// ============================================================
async function diagnosticarProduto(token, produtoHiper, produtoExistente) {
  console.log(`\n🔍 DIAGNÓSTICO PARA "${produtoHiper.nome}":`);
  console.log(`  - ID no Hiper: ${produtoHiper.id}`);
  console.log(`  - SKU principal: ${produtoHiper.codigoDeBarras || 'N/A'}`);
  console.log(`  - Tem variações? ${produtoHiper.variacao && produtoHiper.variacao.length > 0 ? `Sim (${produtoHiper.variacao.length})` : 'Não'}`);
  console.log(`  - Variações: ${produtoHiper.variacao ? produtoHiper.variacao.map(v => v.nomeVariacaoA + (v.nomeVariacaoB ? ' / ' + v.nomeVariacaoB : '')).join(', ') : 'N/A'}`);

  if (produtoExistente) {
    console.log(`  - Produto existe na Shopify? Sim (ID: ${produtoExistente.id})`);
    console.log(`  - Variantes atuais na Shopify:`);
    produtoExistente.variants.forEach(v => {
      console.log(`      - SKU: ${v.sku || 'N/A'}, Título: ${v.title}, ID: ${v.id}`);
    });
    const defaultVariant = produtoExistente.variants.find(v => v.title === 'Default Title');
    if (defaultVariant) {
      console.log(`  - ⚠️ DEFAULT TITLE encontrada! ID: ${defaultVariant.id}, SKU: ${defaultVariant.sku || 'N/A'}`);
    } else {
      console.log(`  - ✅ Nenhuma "Default Title" encontrada.`);
    }
  } else {
    console.log(`  - Produto NÃO existe na Shopify.`);
  }
  console.log(`\n`);
}

// ============================================================
// FUNÇÃO ATUALIZAR PRODUTO (AJUSTADA)
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (preço e estoque)...`);

  await diagnosticarProduto(token, produtoHiper, produtoExistente);

  const temVariacoes = produtoHiper.variacao && produtoHiper.variacao.length > 0;
  const sku = produtoHiper.codigoDeBarras || 
              (temVariacoes ? produtoHiper.variacao[0].codigoDeBarras : '');

  if (!sku) {
    console.error(`❌ Produto "${produtoHiper.nome}" sem SKU. Ignorando.`);
    return null;
  }

  let produtoAtualizado = produtoExistente;
  const defaultVariant = produtoExistente.variants.find(v => v.title === 'Default Title');

  if (defaultVariant) {
    console.log(`🔁 Tentando excluir "Default Title" (ID: ${defaultVariant.id}, SKU: ${defaultVariant.sku || 'N/A'})...`);
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
      const recarregado = await buscarProdutoNaShopifyPorSKU(token, sku);
      if (recarregado) {
        produtoAtualizado = recarregado;
        console.log(`🔄 Produto recarregado após exclusão.`);
      }
    } catch (erro) {
      console.warn(`⚠️ Erro ao excluir "Default Title": ${erro.message}`);
      console.log(`🔄 Tentando recriar o produto do zero...`);
      const excluido = await excluirProdutoShopify(token, produtoExistente.id);
      if (excluido) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return criarProdutoShopify(token, produtoHiper);
      } else {
        console.error(`❌ Falha ao excluir e recriar "${produtoHiper.nome}".`);
        return null;
      }
    }
  }

  // Se não há default, atualiza diretamente as variantes existentes
  try {
    // Para atualizar, vamos usar a mesma estrutura de criação, mas com PUT
    const produtoAtual = produtoAtualizado;
    const variantsExistentes = produtoAtual.variants;
    
    // Mapeia variantes por SKU
    const mapaExistente = {};
    variantsExistentes.forEach(v => { mapaExistente[v.sku] = v; });

    let variantsAtualizados = [];

    // Se tem variações, atualiza/insere cada uma
    if (temVariacoes) {
      const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
      const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;

      produtoHiper.variacao.forEach(variacaoHiper => {
        const varSku = variacaoHiper.codigoDeBarras || '';
        const existente = mapaExistente[varSku];
        const variantData = {
          sku: varSku,
          price: produtoHiper.preco.toString(),
          inventory_quantity: Math.floor(variacaoHiper.quantidadeEmEstoque || 0),
          option1: variacaoHiper.nomeVariacaoA || 'Padrão'
        };
        if (tipoVariacaoB) {
          variantData.option2 = variacaoHiper.nomeVariacaoB || 'Padrão';
        }
        if (existente) {
          variantData.id = existente.id;
        }
        variantsAtualizados.push(variantData);
      });
    } else {
      // Produto sem variações
      const existente = mapaExistente[sku];
      const variantData = {
        sku: sku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0),
        option1: produtoHiper.nome
      };
      if (existente) {
        variantData.id = existente.id;
      }
      variantsAtualizados.push(variantData);
    }

    const atualizacao = {
      product: {
        id: produtoAtual.id,
        title: produtoHiper.nome,
        body_html: produtoHiper.descricao || '',
        vendor: produtoHiper.marca || '',
        product_type: produtoHiper.categoria || '',
        status: produtoHiper.ativo ? 'active' : 'draft',
        variants: variantsAtualizados
      }
    };

    // Adiciona options se o produto tiver variações
    if (temVariacoes) {
      const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
      const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;
      atualizacao.product.options = tipoVariacaoB ? [tipoVariacaoA, tipoVariacaoB] : [tipoVariacaoA];
    }

    const opcoes = {
      hostname: `${CONFIG.shopify.loja}.myshopify.com`,
      path: `/admin/api/2026-07/products/${produtoAtual.id}.json`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      }
    };

    const res = await request(opcoes, JSON.stringify(atualizacao));
    if (res.errors) {
      console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${JSON.stringify(res.errors)}`);
      console.log(`🔄 Tentando recriar o produto do zero...`);
      const excluido = await excluirProdutoShopify(token, produtoAtual.id);
      if (excluido) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return criarProdutoShopify(token, produtoHiper);
      }
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

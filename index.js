const https = require('https');
const fs = require('fs');
const request = require('./src/utils/request.js'); // <-- NOVA IMPORTAÇÃO

// ============================================================
// CARREGAR CONFIGURAÇÕES DAS VARIÁVEIS DE AMBIENTE
// ============================================================
const CONFIG = {
  hiper: { chave: process.env.HIPER_CHAVE },
  shopify: {
    loja: process.env.SHOPIFY_STORE,
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET
  }
};

if (!CONFIG.hiper.chave || !CONFIG.shopify.loja || !CONFIG.shopify.client_id || !CONFIG.shopify.client_secret) {
  console.error('❌ Erro: Variáveis de ambiente não configuradas!');
  process.exit(1);
}

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
// 1. GERAR TOKENS
// ============================================================
function gerarTokenHiper() {
  console.log('🔄 Gerando token do Hiper...');
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: `/api/v1/auth/gerar-token/${CONFIG.hiper.chave}`,
    method: 'GET'
  };
  return request(opcoes).then(res => {
    if (!res.token) throw new Error('Token Hiper não retornado');
    console.log('✅ Token Hiper gerado com sucesso!');
    return res.token;
  });
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
// 2. PRODUTOS
// ============================================================
function buscarProdutosHiper(token, pontoSinc) {
  console.log(`🔄 Buscando produtos do Hiper (ponto: ${pontoSinc})...`);
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: `/api/v1/produtos/pontoDeSincronizacao?pontoDeSincronizacao=${pontoSinc}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  };
  return request(opcoes).then(res => {
    if (res.errors && res.errors.length) throw new Error(res.errors.join(', '));
    console.log(`✅ ${res.produtos?.length || 0} produtos encontrados no Hiper`);
    return res;
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
// FUNÇÃO ATUALIZAR PRODUTO (SEM RECRIAR, APENAS LOG)
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (preço e estoque)...`);

  let sku = produtoHiper.codigoDeBarras || '';
  if (!sku && produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    sku = produtoHiper.variacao[0].codigoDeBarras || `SKU-${Date.now()}`;
  } else if (!sku) {
    sku = `SKU-${Date.now()}`;
  }

  const variantsExistentes = produtoExistente.variants;
  const defaultVariant = variantsExistentes.find(v => v.title === 'Default Title' && !v.sku);
  const mapaExistente = {};
  variantsExistentes.forEach(v => { mapaExistente[v.sku] = v; });

  let variantsAtualizados = [];

  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    produtoHiper.variacao.forEach(variacaoHiper => {
      const varSku = variacaoHiper.codigoDeBarras || sku;
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
    const existente = mapaExistente[sku];
    if (existente) {
      variantsAtualizados.push({
        id: existente.id,
        sku: sku,
        price: produtoHiper.preco.toString(),
        inventory_quantity: Math.floor(produtoHiper.quantidadeEmEstoque || 0)
      });
    } else if (defaultVariant) {
      console.log(`🔁 Substituindo "Default Title" por SKU ${sku}`);
      variantsAtualizados.push({
        id: defaultVariant.id,
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

// ============================================================
// 3. PEDIDOS
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

function enviarPedidoParaHiper(tokenHiper, pedidoShopify, mapaSkuHiper) {
  console.log(`🔄 Enviando pedido #${pedidoShopify.order_number} para o Hiper...`);

  const cliente = {
    documento: '00000000000',
    email: pedidoShopify.email || pedidoShopify.customer?.email || 'cliente@email.com',
    inscricaoEstadual: '',
    nomeDoCliente: pedidoShopify.customer?.first_name + ' ' + pedidoShopify.customer?.last_name || 'Cliente',
    nomeFantasia: ''
  };

  if (pedidoShopify.note_attributes) {
    const cpfAttr = pedidoShopify.note_attributes.find(a => a.name === 'cpf' || a.name === 'documento');
    if (cpfAttr) cliente.documento = cpfAttr.value.replace(/\D/g, '');
  }

  const shipping = pedidoShopify.shipping_address || {};
  const enderecoEntrega = {
    bairro: shipping.city || '',
    cep: (shipping.zip || '').replace(/\D/g, ''),
    codigoIbge: 0,
    complemento: shipping.address2 || '',
    logradouro: shipping.address1 || '',
    numero: '0'
  };

  const billing = pedidoShopify.billing_address || shipping;
  const enderecoCobranca = {
    bairro: billing.city || '',
    cep: (billing.zip || '').replace(/\D/g, ''),
    codigoIbge: 0,
    complemento: billing.address2 || '',
    logradouro: billing.address1 || '',
    numero: '0'
  };

  const itens = [];
  for (const item of pedidoShopify.line_items || []) {
    const sku = item.sku || '';
    const produtoId = mapaSkuHiper[sku];
    if (!produtoId) {
      console.warn(`⚠️ SKU ${sku} não encontrado no Hiper. Pulando item...`);
      continue;
    }
    itens.push({
      produtoId: produtoId,
      quantidade: item.quantity || 1,
      precoUnitarioBruto: parseFloat(item.price) || 0,
      precoUnitarioLiquido: parseFloat(item.price) || 0
    });
  }

  if (itens.length === 0) {
    console.warn(`⚠️ Pedido #${pedidoShopify.order_number} não tem itens válidos. Ignorando.`);
    return Promise.resolve(null);
  }

  const total = parseFloat(pedidoShopify.total_price) || 0;
  const meiosPagamento = [{
    idMeioDePagamento: 4,
    parcelas: 1,
    valor: total
  }];

  let valorFrete = 0;
  if (pedidoShopify.shipping_lines && pedidoShopify.shipping_lines.length > 0) {
    valorFrete = parseFloat(pedidoShopify.shipping_lines[0].price) || 0;
  }

  const payloadHiper = {
    cliente: cliente,
    enderecoDeCobranca: enderecoCobranca,
    enderecoDeEntrega: enderecoEntrega,
    itens: itens,
    meiosDePagamento: meiosPagamento,
    numeroPedidoDeVenda: pedidoShopify.order_number.toString(),
    observacaoDoPedidoDeVenda: `Pedido Shopify #${pedidoShopify.order_number}`,
    valorDoFrete: valorFrete,
    Marketplace: {
      Cnpj: '12345678901234',
      Nome: 'Shopify'
    }
  };

  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: '/api/v1/pedido-de-venda/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenHiper}`
    }
  };

  return request(opcoes, JSON.stringify(payloadHiper)).then(res => {
    if (res.errors && res.errors.length > 0) throw new Error(res.errors.join(', '));
    console.log(`✅ Pedido #${pedidoShopify.order_number} enviado para o Hiper! ID: ${res.id}`);
    return { id: res.id, orderNumber: pedidoShopify.order_number };
  });
}

function consultarPedidoHiper(token, pedidoId) {
  console.log(`🔄 Consultando pedido ${pedidoId} no Hiper...`);
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: `/api/v1/pedido-de-venda/eventos/${pedidoId}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  };
  return request(opcoes).then(res => {
    if (res.errors && res.errors.length > 0) throw new Error(res.errors.join(', '));
    console.log(`✅ Pedido ${pedidoId}: Situação ${res.codigoDaSituacaoDeProcessamento} | Cancelado: ${res.cancelado}`);
    console.log(`   Código NF: ${res.codigoDoPedidoDeVenda}`);
    return res;
  });
}

function cancelarPedidoHiper(token, pedidoId) {
  console.log(`🔄 Cancelando pedido ${pedidoId} no Hiper...`);
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: `/api/v1/pedido-de-venda/cancelar/${pedidoId}`,
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` }
  };
  return request(opcoes).then(res => {
    if (res.errors && res.errors.length > 0) throw new Error(res.errors.join(', '));
    console.log(`✅ Pedido ${pedidoId} cancelado com sucesso!`);
    console.log(`   Mensagem: ${res.message}`);
    return res;
  });
}

// ============================================================
// FUNÇÃO PRINCIPAL
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

    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue;
      if (produto.produtoPrimarioId && produto.produtoPrimarioId !== '00000000-0000-0000-0000-000000000000') continue;

      try {
        const sku = produto.variacao && produto.variacao.length > 0 
          ? produto.variacao[0].codigoDeBarras 
          : produto.codigoDeBarras;

        if (!sku) {
          console.warn(`⚠️ Produto "${produto.nome}" sem SKU, ignorando...`);
          continue;
        }

        const existe = await buscarProdutoNaShopifyPorSKU(tokenShopify, sku);

        if (existe) {
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
          if (atualizado) atualizados++;
        } else {
          await criarProdutoShopify(tokenShopify, produto);
          criados++;
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
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

module.exports = { sincronizar, consultarPedidoHiper, cancelarPedidoHiper };
sincronizar();
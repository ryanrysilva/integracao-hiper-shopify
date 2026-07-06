const https = require('https');
const fs = require('fs');

// ============================================================
// CARREGAR CONFIGURAÇÕES DAS VARIÁVEIS DE AMBIENTE
// ============================================================
const CONFIG = {
  hiper: {
    chave: process.env.HIPER_CHAVE
  },
  shopify: {
    loja: process.env.SHOPIFY_STORE,
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET
  }
};

if (!CONFIG.hiper.chave || !CONFIG.shopify.loja || !CONFIG.shopify.client_id || !CONFIG.shopify.client_secret) {
  console.error('❌ Erro: Variáveis de ambiente não configuradas!');
  console.error('   Defina: HIPER_CHAVE, SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

// ============================================================
// ESTADO (com fallback)
// ============================================================
let ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
if (fs.existsSync('state.json')) {
  try {
    ESTADO = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    // Garante que pontoDeSincronizacao seja um número válido
    if (isNaN(ESTADO.pontoDeSincronizacao) || ESTADO.pontoDeSincronizacao < 0) {
      ESTADO.pontoDeSincronizacao = 0;
    }
  } catch (e) {
    console.warn('⚠️ state.json corrompido, resetando...');
    ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
  }
}

// ============================================================
// FUNÇÃO HTTP GENÉRICA
// ============================================================
function request(opcoes, dados = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opcoes, (res) => {
      let resposta = '';
      res.on('data', (chunk) => resposta += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(resposta));
        } catch (e) {
          reject(new Error('Erro ao parsear: ' + resposta.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
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
// 2. PRODUTOS (CRIAR, ATUALIZAR, BUSCAR)
// ============================================================
function buscarProdutosHiper(token, pontoSinc = 0) {
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
      produtoShopify.product.variants.push({
        title: variacao.nomeVariacaoA + (variacao.nomeVariacaoB ? ' / ' + variacao.nomeVariacaoB : ''),
        price: produtoHiper.preco.toString(),
        sku: variacao.codigoDeBarras || '',
        inventory_quantity: Math.floor(variacao.quantidadeEmEstoque || 0)
      });
    });
  } else {
    produtoShopify.product.variants.push({
      price: produtoHiper.preco.toString(),
      sku: produtoHiper.codigoDeBarras || '',
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
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`✅ Produto "${produtoHiper.nome}" CRIADO na Shopify! ID: ${res.product.id}`);
    return res.product;
  });
}

function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (incluindo PREÇO e ESTOQUE)...`);

  let variantsAtualizados = [];

  if (produtoHiper.variacao && produtoHiper.variacao.length > 0) {
    const mapaExistente = {};
    produtoExistente.variants.forEach(v => { mapaExistente[v.sku] = v; });

    produtoHiper.variacao.forEach(variacaoHiper => {
      const sku = variacaoHiper.codigoDeBarras || '';
      const existente = mapaExistente[sku];
      
      if (existente) {
        variantsAtualizados.push({
          id: existente.id,
          sku: sku,
          price: produtoHiper.preco.toString(),
          inventory_quantity: Math.floor(variacaoHiper.quantidadeEmEstoque || 0)
        });
      } else {
        variantsAtualizados.push({
          sku: sku,
          price: produtoHiper.preco.toString(),
          inventory_quantity: Math.floor(variacaoHiper.quantidadeEmEstoque || 0)
        });
      }
    });
  } else {
    const sku = produtoHiper.codigoDeBarras || '';
    const existente = produtoExistente.variants[0];
    
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

  return request(opcoes, JSON.stringify(atualizacao)).then(res => {
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    console.log(`✅ Produto "${produtoHiper.nome}" ATUALIZADO (preço/estoque) na Shopify!`);
    return res.product;
  });
}

// ============================================================
// 3. PEDIDOS (BUSCAR NA SHOPIFY E ENVIAR PARA O HIPER)
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

// ============================================================
// 4. CONSULTAR PEDIDO NO HIPER
// ============================================================
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

// ============================================================
// 5. CANCELAR PEDIDO NO HIPER
// ============================================================
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
// FUNÇÃO PRINCIPAL (com fallback e salvamento condicional)
// ============================================================
async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');
  
  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    // --- PARTE 1: PRODUTOS ---
    const produtosHiper = await buscarProdutosHiper(tokenHiper, ESTADO.pontoDeSincronizacao || 0);

    // Se não encontrou produtos, pode ser porque o ponto salvo está avançado.
    // Tenta com ponto=0 como fallback
    let produtos = produtosHiper.produtos || [];
    let ponto = produtosHiper.pontoDeSincronizacao;

    if (produtos.length === 0 && ESTADO.pontoDeSincronizacao > 0) {
      console.warn('⚠️ Nenhum produto com o ponto atual. Tentando sincronização completa (ponto=0)...');
      const fallback = await buscarProdutosHiper(tokenHiper, 0);
      if (fallback.produtos && fallback.produtos.length > 0) {
        produtos = fallback.produtos;
        ponto = fallback.pontoDeSincronizacao;
        console.log(`✅ Fallback encontrou ${produtos.length} produtos.`);
      }
    }

    // Constrói mapa SKU -> ID do Hiper
    const mapaSkuHiper = {};
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => {
          if (v.codigoDeBarras) mapaSkuHiper[v.codigoDeBarras] = v.id;
        });
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
          await atualizarProdutoShopify(tokenShopify, produto, existe);
          atualizados++;
        } else {
          await criarProdutoShopify(tokenShopify, produto);
          criados++;
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
    }

    // SÓ SALVA O PONTO SE TIVER PRODUTOS ENCONTRADOS
    if (produtos.length > 0 && ponto && !isNaN(ponto) && ponto >= 0) {
      // Só atualiza se o novo ponto for maior que o atual (evita regressão)
      if (ponto > ESTADO.pontoDeSincronizacao) {
        ESTADO.pontoDeSincronizacao = ponto;
        console.log(`📌 Ponto de sincronização atualizado para ${ponto}`);
      } else {
        console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) já é maior ou igual ao novo (${ponto}), mantendo.`);
      }
    } else {
      console.log(`📌 Nenhum produto encontrado. Ponto de sincronização NÃO foi alterado.`);
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);

    // --- PARTE 2: PEDIDOS NOVOS ---
    const pedidos = await buscarPedidosShopify(tokenShopify, ESTADO.ultimoPedidoId || 0);

    let enviados = 0;
    const pedidosEnviados = [];
    for (const pedido of pedidos) {
      try {
        const resultado = await enviarPedidoParaHiper(tokenHiper, pedido, mapaSkuHiper);
        if (resultado) {
          enviados++;
          pedidosEnviados.push({
            orderNumber: pedido.order_number,
            hiperId: resultado.id
          });
        }
        if (pedido.id > ESTADO.ultimoPedidoId) {
          ESTADO.ultimoPedidoId = pedido.id;
        }
      } catch (erro) {
        console.error(`❌ Erro ao enviar pedido #${pedido.order_number}:`, erro.message);
      }
    }

    console.log(`\n--- SINC. PEDIDOS CONCLUÍDA ---`);
    console.log(`📦 ${enviados} pedidos enviados para o Hiper.`);

    // --- PARTE 3: CONSULTAR PEDIDOS ENVIADOS ---
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

    // Salva o estado (apenas se houver alterações relevantes)
    fs.writeFileSync('state.json', JSON.stringify(ESTADO, null, 2));
    console.log(`\n✅ ESTADO SALVO. Próxima execução não repetirá os mesmos itens.`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
  }
}

// ============================================================
// EXPORTAR FUNÇÕES
// ============================================================
module.exports = {
  sincronizar,
  consultarPedidoHiper,
  cancelarPedidoHiper
};

// ============================================================
// EXECUTAR
// ============================================================
sincronizar();
// src/services/hiper.js
const request = require('../utils/request.js');
const CONFIG = require('../config/index.js');

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

module.exports = {
  gerarTokenHiper,
  buscarProdutosHiper,
  enviarPedidoParaHiper,
  consultarPedidoHiper,
  cancelarPedidoHiper
};

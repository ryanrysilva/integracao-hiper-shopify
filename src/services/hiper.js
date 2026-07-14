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

// ============================================================
// BUSCA PRODUTOS — COM DISTINÇÃO ENTRE "SEM NOVIDADES" E ERRO REAL
// ------------------------------------------------------------
// O endpoint de pontoDeSincronizacao do Hiper devolve um "erro"
// ("Nenhum produto encontrado") quando não há nada de novo a partir
// do ponto informado. Isso NÃO é uma falha da integração — é o
// resultado normal na maioria dos ciclos (a loja nem sempre tem
// produto alterado a cada 10 minutos). Por isso essa mensagem
// específica é tratada como "sem novidades" (sucesso, lista vazia).
// Qualquer OUTRA mensagem de erro continua sendo lançada como
// exceção de verdade, pra acionar o mecanismo de retry/recuperação
// em sync.js.
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
    const mensagensErro = Array.isArray(res.errors) ? res.errors.join(', ') : '';

    if (mensagensErro && /nenhum produto encontrado/i.test(mensagensErro)) {
      console.log(`ℹ️ Hiper: nenhuma novidade a partir do ponto ${pontoSinc}.`);
      // Importante: NÃO confiamos em res.pontoDeSincronizacao aqui. Numa
      // resposta de "sem novidades" o Hiper costuma devolver esse campo
      // zerado (é um payload de erro, não um cursor de verdade) — usar
      // "??" deixaria esse 0 passar e resetaria o ponto de sincronização
      // real. Em "sem novidades" o ponto correto é sempre o mesmo que já
      // tínhamos.
      return {
        produtos: [],
        pontoDeSincronizacao: pontoSinc,
        semNovidades: true
      };
    }

    if (res.errors && res.errors.length) {
      throw new Error(mensagensErro || 'Erro desconhecido ao buscar produtos no Hiper');
    }

    console.log(`✅ ${res.produtos?.length || 0} produtos encontrados no Hiper`);
    console.log(`🔎 pontoDeSincronizacao retornado pelo Hiper: ${res.pontoDeSincronizacao}`);

    // ============================================================
    // LOG DE DIAGNÓSTICO PARA A BLUSA ASTER
    // ============================================================
    const aster = res.produtos?.find(p => p.nome === 'Blusa Aster');
    if (aster) {
      console.log('🔍 DETALHES DA BLUSA ASTER:');
      console.log('  grade:', aster.grade);
      console.log('  variacao:', aster.variacao ? JSON.stringify(aster.variacao) : 'null');
      console.log('  variacaoAtiva:', aster.variacaoAtiva);
      console.log('  codigoDeBarras:', aster.codigoDeBarras);
    } else {
      console.log('⚠️ Blusa Aster NÃO encontrada na lista de produtos.');
    }
    // ============================================================

    return {
      produtos: res.produtos || [],
      pontoDeSincronizacao: res.pontoDeSincronizacao,
      semNovidades: false
    };
  });
}

// ============================================================
// ENVIA PEDIDO DE VENDA PARA O HIPER
// ------------------------------------------------------------
// enriquecimento (opcional, resolvido em sync.js antes de chamar):
//   documentoCliente     — CPF/CNPJ já limpo (só dígitos)
//   idMeioDePagamento    — ID do meio de pagamento no Hiper
//   codigoIbgeEntrega    — código IBGE da cidade de entrega
//   codigoIbgeCobranca   — código IBGE da cidade de cobrança
// Se não vier nada, cai nos mesmos fallbacks de antes (documento
// genérico, pagamento 4 = cartão de crédito, IBGE 0).
// ============================================================
function enviarPedidoParaHiper(tokenHiper, pedidoShopify, mapaSkuHiper, enriquecimento = {}) {
  console.log(`🔄 Enviando pedido #${pedidoShopify.order_number} para o Hiper...`);

  const cliente = {
    documento: enriquecimento.documentoCliente || '00000000000',
    email: pedidoShopify.email || pedidoShopify.customer?.email || 'cliente@email.com',
    inscricaoEstadual: '',
    nomeDoCliente: pedidoShopify.customer?.first_name + ' ' + pedidoShopify.customer?.last_name || 'Cliente',
    nomeFantasia: ''
  };

  if (!enriquecimento.documentoCliente && pedidoShopify.note_attributes) {
    const nomesPossiveis = ['cpf', 'documento', 'cpf/cnpj', 'cpf_cnpj', 'documento_fiscal', 'tax_id', 'cnpj'];
    const cpfAttr = pedidoShopify.note_attributes.find(a => nomesPossiveis.includes((a.name || '').toLowerCase()));
    if (cpfAttr) cliente.documento = cpfAttr.value.replace(/\D/g, '');
  }
  if (cliente.documento === '00000000000') {
    console.warn(`⚠️ Pedido #${pedidoShopify.order_number}: CPF/CNPJ do cliente não encontrado. Enviando documento genérico — pode ser necessário corrigir manualmente no Hiper para emissão fiscal.`);
  }

  const shipping = pedidoShopify.shipping_address || {};
  const enderecoEntrega = {
    bairro: shipping.city || '',
    cep: (shipping.zip || '').replace(/\D/g, ''),
    codigoIbge: enriquecimento.codigoIbgeEntrega || 0,
    complemento: shipping.address2 || '',
    logradouro: shipping.address1 || '',
    numero: '0'
  };
  const billing = pedidoShopify.billing_address || shipping;
  const enderecoCobranca = {
    bairro: billing.city || '',
    cep: (billing.zip || '').replace(/\D/g, ''),
    codigoIbge: enriquecimento.codigoIbgeCobranca || 0,
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
    idMeioDePagamento: enriquecimento.idMeioDePagamento || 4,
    parcelas: 1,
    valor: total
  }];

  let valorFrete = 0;
  if (pedidoShopify.shipping_lines && pedidoShopify.shipping_lines.length > 0) {
    valorFrete = parseFloat(pedidoShopify.shipping_lines[0].price) || 0;
  }

  // Marketplace.Cnpj só é exigido pelo Hiper quando o estabelecimento
  // é de Santa Catarina (SC). O valor fixo que existia antes
  // ('12345678901234') NÃO é um CNPJ válido — era um placeholder que
  // nunca foi trocado. Agora só enviamos o bloco Marketplace se um
  // CNPJ real estiver configurado em HIPER_MARKETPLACE_CNPJ.
  const marketplaceCnpj = (process.env.HIPER_MARKETPLACE_CNPJ || '').replace(/\D/g, '');

  const payloadHiper = {
    cliente: cliente,
    enderecoDeCobranca: enderecoCobranca,
    enderecoDeEntrega: enderecoEntrega,
    itens: itens,
    meiosDePagamento: meiosPagamento,
    numeroPedidoDeVenda: pedidoShopify.order_number.toString(),
    observacaoDoPedidoDeVenda: `Pedido Shopify #${pedidoShopify.order_number}`,
    valorDoFrete: valorFrete,
    ...(marketplaceCnpj ? { Marketplace: { Cnpj: marketplaceCnpj, Nome: 'Shopify' } } : {})
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

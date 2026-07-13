// src/services/pagamento.js
// ============================================================
// MAPEIA FORMA DE PAGAMENTO DA SHOPIFY -> ID DO HIPER
// ------------------------------------------------------------
// IDs conforme a documentação oficial do Hiper:
//   1 Dinheiro | 2 Cheque | 3 Devolução | 4 Cartão de crédito
//   5 Cartão de débito | 6 Crediário | 11 Cartão voucher | 12 Pix
//
// A Shopify não tem um ID fixo de forma de pagamento — o nome do
// gateway varia conforme o que está configurado na loja. Os padrões
// abaixo cobrem os casos mais comuns no Brasil, mas VALE A PENA
// revisar os logs de "gateway não mapeado" depois de rodar em
// produção por um tempo e ajustar aqui se aparecer algo específico
// da sua loja (ex.: nome de um gateway de pagamento parcelado).
// ============================================================

const PADROES = [
  { regex: /pix/i, id: 12 },
  { regex: /boleto/i, id: 1 }, // Hiper não tem "boleto" como opção própria — tratado como Dinheiro
  { regex: /d[eé]bito|debit/i, id: 5 },
  { regex: /voucher/i, id: 11 },
  { regex: /cheque/i, id: 2 },
  { regex: /cr[eé]dito|credit|shopify.?payments|visa|master|amex|elo|hipercard/i, id: 4 }
];

const ID_PADRAO = 4; // Cartão de crédito — mesmo default que já existia no código anterior

function mapearMeioDePagamento(pedidoShopify) {
  const nomes = (pedidoShopify.payment_gateway_names || []).join(' ');
  for (const { regex, id } of PADROES) {
    if (regex.test(nomes)) return id;
  }
  if (nomes) {
    console.warn(`⚠️ Gateway de pagamento não mapeado: "${nomes}". Usando padrão (Cartão de crédito, ID ${ID_PADRAO}). Se esse gateway aparecer com frequência, vale adicionar um padrão específico em pagamento.js.`);
  }
  return ID_PADRAO;
}

module.exports = { mapearMeioDePagamento };

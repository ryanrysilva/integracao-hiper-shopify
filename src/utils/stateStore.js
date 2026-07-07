// src/utils/stateStore.js
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = 'hiper_shopify_sync_state';

const ESTADO_PADRAO = {
  ultimoPedidoId: 0,
  pontoDeSincronizacao: 0,
  mapaSkuHiper: {},
  produtosMap: {}
};

function verificarConfig() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN precisam estar configurados.');
  }
}

async function carregarEstado() {
  verificarConfig();
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${STATE_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) {
      console.log('ℹ️ Nenhum estado salvo no Upstash. Iniciando do zero.');
      return { ...ESTADO_PADRAO };
    }
    const estado = JSON.parse(data.result);
    if (isNaN(estado.pontoDeSincronizacao) || estado.pontoDeSincronizacao < 0) estado.pontoDeSincronizacao = 0;
    if (!estado.mapaSkuHiper) estado.mapaSkuHiper = {};
    if (!estado.produtosMap) estado.produtosMap = {};
    if (!estado.ultimoPedidoId) estado.ultimoPedidoId = 0;
    return estado;
  } catch (erro) {
    console.error('❌ Erro ao carregar estado do Upstash:', erro.message);
    return { ...ESTADO_PADRAO };
  }
}

async function salvarEstado(estado) {
  verificarConfig();
  try {
    const res = await fetch(`${UPSTASH_URL}/set/${STATE_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify(estado)
    });
    const data = await res.json();
    if (data.result !== 'OK') {
      console.error('❌ Falha ao salvar estado:', JSON.stringify(data));
    }
  } catch (erro) {
    console.error('❌ Erro ao salvar estado:', erro.message);
  }
}

module.exports = { carregarEstado, salvarEstado };
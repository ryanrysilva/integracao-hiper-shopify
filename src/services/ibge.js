// src/services/ibge.js
const request = require('../utils/request.js');

// ============================================================
// RESOLVE CÓDIGO IBGE (UF + CIDADE) PARA USO NOS ENDEREÇOS
// ENVIADOS AO HIPER (campo enderecoDe*.codigoIbge)
// ------------------------------------------------------------
// A Shopify não fornece código IBGE nativamente — só cidade e UF
// (province_code). Usamos a API pública do IBGE pra resolver isso,
// com cache em memória por UF (a lista de municípios de um estado
// não muda em tempo de execução, então buscamos uma vez por UF e
// reaproveitamos).
// ============================================================

function normalizar(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .trim()
    .toUpperCase();
}

const cachePorUf = {};

async function obterMunicipiosDoEstado(uf) {
  const ufNormalizado = (uf || '').trim().toUpperCase();
  if (!ufNormalizado) return [];
  if (cachePorUf[ufNormalizado]) return cachePorUf[ufNormalizado];

  const opcoes = {
    hostname: 'servicodados.ibge.gov.br',
    path: `/api/v1/localidades/estados/${ufNormalizado}/municipios`,
    method: 'GET'
  };

  try {
    const res = await request(opcoes);
    const lista = Array.isArray(res) ? res : [];
    cachePorUf[ufNormalizado] = lista;
    return lista;
  } catch (err) {
    console.warn(`⚠️ Não foi possível buscar municípios do IBGE para UF "${ufNormalizado}": ${err.message}`);
    return [];
  }
}

async function obterCodigoIbge(uf, cidade) {
  if (!uf || !cidade) return 0;
  const municipios = await obterMunicipiosDoEstado(uf);
  const alvo = normalizar(cidade);
  const encontrado = municipios.find(m => normalizar(m.nome) === alvo);
  if (!encontrado) {
    console.warn(`⚠️ Código IBGE não encontrado para "${cidade}/${uf}". Usando 0 — talvez precise corrigir manualmente no Hiper.`);
    return 0;
  }
  return encontrado.id;
}

module.exports = { obterCodigoIbge };

// src/config/index.js
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

// Verifica se todas as variáveis estão preenchidas
if (!CONFIG.hiper.chave || !CONFIG.shopify.loja || !CONFIG.shopify.client_id || !CONFIG.shopify.client_secret) {
  console.error('❌ Erro: Variáveis de ambiente não configuradas!');
  console.error('   Defina: HIPER_CHAVE, SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

module.exports = CONFIG;
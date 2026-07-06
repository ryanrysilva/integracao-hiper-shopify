// server.js
const express = require('express');
const { sincronizar } = require('./index.js');

const app = express();
const port = process.env.PORT || 3000;

// Rota principal (para o ping do cron-job.org)
app.get('/', (req, res) => {
  res.send('Integração Hiper-Shopify está online!');
});

// Rota para disparar a sincronização manualmente
app.get('/sync', async (req, res) => {
  console.log('🔄 Sincronização manual iniciada...');
  try {
    await sincronizar();
    res.status(200).send('Sincronização concluída com sucesso.');
  } catch (error) {
    console.error('❌ Erro na sincronização:', error.message);
    res.status(500).send('Erro na sincronização. Verifique os logs.');
  }
});

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
});
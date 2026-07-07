// server.js
const express = require('express');
const { sincronizar } = require('./src/services/sync.js');

const app = express();
const port = process.env.PORT || 3000;

// Rota principal (para o ping do cron-job.org)
app.get('/', (req, res) => {
  res.send('Integração Hiper-Shopify está online!');
});

// Rota para disparar a sincronização (resposta imediata)
app.get('/sync', (req, res) => {
  // Responde imediatamente com 202 Accepted
  res.status(202).send('Sincronização iniciada em background.');
  
  // Executa a sincronização em segundo plano (fire-and-forget)
  sincronizar().catch(err => {
    console.error('❌ Erro na sincronização em background:', err.message);
  });
});

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
});

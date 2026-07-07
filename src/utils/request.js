// src/utils/request.js
const https = require('https');

function request(options, data = null, retries = 3, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const requestOptions = { ...options, timeout };
    const req = https.request(requestOptions, (res) => {
      let responseData = '';
      const statusCode = res.statusCode;

      if (statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
        if (retries > 0) {
          const delay = Math.pow(2, 3 - retries) * 1000;
          console.warn(`⚠️ Status ${statusCode}. Tentando novamente em ${delay}ms... (${retries} tentativas restantes)`);
          setTimeout(() => {
            request(options, data, retries - 1, timeout)
              .then(resolve)
              .catch(reject);
          }, delay);
        } else {
          reject(new Error(`Falha após múltiplas tentativas. Último status: ${statusCode}`));
        }
        return;
      }

      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          if (res.headers['content-type']?.includes('application/json')) {
            resolve(JSON.parse(responseData));
          } else {
            resolve(responseData);
          }
        } catch (e) {
          reject(new Error(`Erro ao parsear resposta: ${e.message}. Resposta: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      if (retries > 0) {
        const delay = Math.pow(2, 3 - retries) * 1000;
        console.warn(`⚠️ Erro na requisição: ${err.message}. Tentando novamente em ${delay}ms...`);
        setTimeout(() => {
          request(options, data, retries - 1, timeout)
            .then(resolve)
            .catch(reject);
        }, delay);
      } else {
        reject(new Error(`Falha na requisição: ${err.message}`));
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout após ${timeout}ms`));
    });

    if (data) {
      if (typeof data === 'string') {
        req.write(data);
      } else {
        req.write(JSON.stringify(data));
      }
    }
    req.end();
  });
}

module.exports = request;
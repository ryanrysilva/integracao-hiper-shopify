// src/services/sync.js
const fs = require('fs');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const { gerarTokenShopify, buscarProdutoNaShopifyPorSKU, criarProdutoShopify, atualizarProdutoShopify, buscarPedidosShopify } = require('./shopify.js');

let ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
if (fs.existsSync('state.json')) {
  try {
    ESTADO = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    if (isNaN(ESTADO.pontoDeSincronizacao) || ESTADO.pontoDeSincronizacao < 0) ESTADO.pontoDeSincronizacao = 0;
  } catch (e) {
    console.warn('⚠️ state.json corrompido, resetando...');
    ESTADO = { ultimoPedidoId: 0, pontoDeSincronizacao: 0 };
  }
}

async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');
  
  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    let produtos = [];
    let ponto = 0;
    let pontoOriginal = ESTADO.pontoDeSincronizacao;

    try {
      const resposta = await buscarProdutosHiper(tokenHiper, pontoOriginal);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
    } catch (erro) {
      console.warn(`⚠️ Erro ao buscar com ponto ${pontoOriginal}: ${erro.message}`);
      console.warn('🔄 Tentando sincronização completa com ponto=0...');
      const resposta = await buscarProdutosHiper(tokenHiper, 0);
      produtos = resposta.produtos || [];
      ponto = resposta.pontoDeSincronizacao;
    }

    if (produtos.length === 0) {
      console.warn('⚠️ Nenhum produto encontrado.');
    } else {
      console.log(`✅ ${produtos.length} produtos encontrados no Hiper.`);
    }

    const mapaSkuHiper = {};
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => { if (v.codigoDeBarras) mapaSkuHiper[v.codigoDeBarras] = v.id; });
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
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
          if (atualizado) atualizados++;
        } else {
          await criarProdutoShopify(tokenShopify, produto);
          criados++;
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
    }

    if (produtos.length > 0 && (criados > 0 || atualizados > 0)) {
      if (ponto && !isNaN(ponto) && ponto >= 0 && ponto > ESTADO.pontoDeSincronizacao) {
        ESTADO.pontoDeSincronizacao = ponto;
        console.log(`📌 Ponto de sincronização atualizado para ${ponto}`);
      } else {
        console.log(`📌 Ponto atual (${ESTADO.pontoDeSincronizacao}) mantido.`);
      }
    } else {
      console.log(`📌 Nenhum produto processado com sucesso. Ponto NÃO alterado.`);
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);

    const pedidos = await buscarPedidosShopify(tokenShopify, ESTADO.ultimoPedidoId || 0);
    let enviados = 0;
    const pedidosEnviados = [];
    for (const pedido of pedidos) {
      try {
        const resultado = await enviarPedidoParaHiper(tokenHiper, pedido, mapaSkuHiper);
        if (resultado) {
          enviados++;
          pedidosEnviados.push({ orderNumber: pedido.order_number, hiperId: resultado.id });
        }
        if (pedido.id > ESTADO.ultimoPedidoId) ESTADO.ultimoPedidoId = pedido.id;
      } catch (erro) {
        console.error(`❌ Erro ao enviar pedido #${pedido.order_number}:`, erro.message);
      }
    }

    console.log(`\n--- SINC. PEDIDOS CONCLUÍDA ---`);
    console.log(`📦 ${enviados} pedidos enviados para o Hiper.`);

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

    fs.writeFileSync('state.json', JSON.stringify(ESTADO, null, 2));
    console.log(`\n✅ ESTADO SALVO.`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
  }
}

module.exports = { sincronizar };
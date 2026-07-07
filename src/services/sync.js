// src/services/sync.js
const fs = require('fs');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const { gerarTokenShopify, buscarProdutoPorSKU, criarProdutoShopify, arquivarProdutoShopify, buscarPedidosShopify } = require('./shopify.js');

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

    // Constrói mapa SKU -> ID Hiper (para pedidos)
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
    let arquivados = 0;

    // Lista para rastrear SKUs que já foram processados na criação
    const skusProcessados = new Set();

    // Primeiro: arquiva produtos existentes com os mesmos SKUs (se não tiverem metafield)
    console.log('\n🧹 Verificando produtos existentes para evitar duplicatas...');
    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue;
      if (produto.produtoPrimarioId && produto.produtoPrimarioId !== '00000000-0000-0000-0000-000000000000') continue;

      let sku = produto.codigoDeBarras;
      if (!sku && produto.variacao && produto.variacao.length > 0) {
        sku = produto.variacao[0].codigoDeBarras;
      }
      if (!sku) continue;

      try {
        const existe = await buscarProdutoPorSKU(tokenShopify, sku);
        if (existe) {
          // Verifica se o produto tem metafield do Hiper
          const temMetafield = existe.metafields && existe.metafields.some(mf => 
            mf.namespace === 'hiper' && mf.key === 'product_id'
          );
          if (!temMetafield) {
            console.log(`📦 Arquivando produto antigo "${produto.nome}" (SKU: ${sku})...`);
            await arquivarProdutoShopify(tokenShopify, existe.id);
            arquivados++;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      } catch (erro) {
        console.warn(`⚠️ Erro ao verificar produto ${produto.nome}: ${erro.message}`);
      }
    }

    // Segundo: cria ou atualiza os produtos
    console.log('\n🚀 Criando/atualizando produtos...');
    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue;
      if (produto.produtoPrimarioId && produto.produtoPrimarioId !== '00000000-0000-0000-0000-000000000000') continue;

      try {
        let sku = produto.codigoDeBarras;
        if (!sku && produto.variacao && produto.variacao.length > 0) {
          sku = produto.variacao[0].codigoDeBarras;
        }
        if (!sku) {
          console.warn(`⚠️ Produto "${produto.nome}" sem SKU. Ignorando.`);
          continue;
        }

        // Se este SKU já foi processado nesta execução, pula (evita loop)
        if (skusProcessados.has(sku)) {
          console.log(`⏩ SKU ${sku} já processado. Pulando...`);
          continue;
        }

        // Busca novamente (pode ter sido arquivado)
        const existe = await buscarProdutoPorSKU(tokenShopify, sku);

        if (existe) {
          console.log(`📦 Produto "${produto.nome}" encontrado (SKU: ${sku}). Atualizando...`);
          // Verifica se tem metafield
          const temMetafield = existe.metafields && existe.metafields.some(mf => 
            mf.namespace === 'hiper' && mf.key === 'product_id'
          );
          if (temMetafield) {
            // Se tem metafield, apenas atualiza
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              atualizados++;
              skusProcessados.add(sku);
            }
          } else {
            // Se não tem metafield, arquiva e recria
            console.log(`🔄 Produto "${produto.nome}" sem metafield. Recriando...`);
            await arquivarProdutoShopify(tokenShopify, existe.id);
            await new Promise(resolve => setTimeout(resolve, 500));
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              criados++;
              skusProcessados.add(sku);
            }
          }
        } else {
          // Produto não existe, cria
          console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
          const novo = await criarProdutoShopify(tokenShopify, produto);
          if (novo) {
            criados++;
            skusProcessados.add(sku);
          }
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
    }

    if (produtos.length > 0 && (criados > 0 || atualizados > 0 || arquivados > 0)) {
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
    console.log(`📦 ${arquivados} produtos ARQUIVADOS (antigos).`);

    // --- PEDIDOS ---
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

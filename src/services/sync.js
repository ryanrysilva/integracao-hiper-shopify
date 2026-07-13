// src/services/sync.js
const request = require('../utils/request.js');
const { carregarEstado, salvarEstado } = require('../utils/stateStore.js');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const { obterCodigoIbge } = require('./ibge.js');
const { mapearMeioDePagamento } = require('./pagamento.js');
const {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarDadosAtuaisProdutoShopify,
  buscarCpfCnpjDoPedido,
  buscarPedidosShopify,
  buscarPedidosCanceladosShopify,
  adicionarTagAoPedidoShopify,
  sleep
} = require('./shopify.js');

// ============================================================
// FUNÇÕES AUXILIARES PARA MAPEAMENTO DE PRODUTOS
// ============================================================
function extrairMapaProduto(produtoShopifyResp) {
  return {
    shopifyId: produtoShopifyResp.id,
    variants: (produtoShopifyResp.variants || []).map(v => ({
      sku: v.sku,
      variantId: v.id,
      inventoryItemId: v.inventory_item_id
    }))
  };
}

function mapaParaProdutoExistente(mapaEntry) {
  return {
    id: mapaEntry.shopifyId,
    variants: mapaEntry.variants.map(v => ({
      id: v.variantId,
      sku: v.sku,
      inventory_item_id: v.inventoryItemId,
      title: v.sku || 'Variant'
    }))
  };
}

// ============================================================
// FALLBACK: BUSCA POR METAFIELD
// ============================================================
async function buscarProdutoPorMetafield(token, hiperId) {
  console.log(`🔍 [fallback] Buscando produto pelo metafield: hiper.product_id = ${hiperId}`);
  const query = `{
    products(first: 1, query: "metafields.hiper.product_id:'${hiperId}'") {
      edges {
        node {
          id
          title
          metafields(first: 10) {
            edges { node { namespace key value } }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }`;
  const opcoes = {
    hostname: `${process.env.SHOPIFY_STORE}.myshopify.com`,
    path: '/admin/api/2026-07/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };
  try {
    const res = await request(opcoes, JSON.stringify({ query }));
    if (res.errors) throw new Error(JSON.stringify(res.errors));
    const edges = res.data?.products?.edges || [];
    if (edges.length === 0) return null;
    const product = edges[0].node;
    const metafields = product.metafields.edges.map(edge => ({
      namespace: edge.node.namespace,
      key: edge.node.key,
      value: edge.node.value
    }));
    const metafieldConfere = metafields.some(
      mf => mf.namespace === 'hiper' && mf.key === 'product_id' && mf.value === hiperId
    );
    if (!metafieldConfere) return null;
    return {
      id: product.id.replace('gid://shopify/Product/', ''),
      title: product.title,
      variants: product.variants.edges.map(edge => ({
        id: edge.node.id.replace('gid://shopify/ProductVariant/', ''),
        title: edge.node.title,
        sku: edge.node.sku,
        price: edge.node.price,
        inventory_quantity: edge.node.inventoryQuantity,
        inventory_item_id: edge.node.inventoryItem?.id?.replace('gid://shopify/InventoryItem/', '')
      })),
      metafields
    };
  } catch (err) {
    console.error(`❌ Erro no fallback de busca por metafield ${hiperId}:`, err.message);
    return null;
  }
}

// ============================================================
// ARQUIVA UM PRODUTO MAPEADO NA SHOPIFY
// ------------------------------------------------------------
// Só remove do mapa local se a arquivação na Shopify realmente
// funcionar. Se falhar, mantemos o mapeamento pra tentar de novo
// no próximo ciclo em vez de "esquecer" o produto e ele ficar
// ativo na loja pra sempre por engano.
// ============================================================
async function arquivarSeMapeado(tokenShopify, ESTADO, hiperId, motivo) {
  const mapaEntry = ESTADO.produtosMap[hiperId];
  if (!mapaEntry) return false;
  console.log(`🗑️ Produto ${hiperId} ${motivo}. Arquivando na Shopify...`);
  const ok = await arquivarProdutoShopify(tokenShopify, mapaEntry.shopifyId);
  if (ok) {
    delete ESTADO.produtosMap[hiperId];
    return true;
  }
  console.warn(`⚠️ Falha ao arquivar produto ${hiperId} — mantendo o mapeamento para tentar de novo no próximo ciclo.`);
  return false;
}

// ============================================================
// FUNÇÃO PRINCIPAL DE SINCRONIZAÇÃO
// ============================================================
async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');
  let ESTADO = await carregarEstado();
  if (ESTADO.falhasPonto === undefined) ESTADO.falhasPonto = 0;
  if (ESTADO.ultimaSyncCompletaEm === undefined) ESTADO.ultimaSyncCompletaEm = 0;
  if (ESTADO.pedidosMap === undefined) ESTADO.pedidosMap = {};
  if (ESTADO.ultimaChecagemCancelamentoEm === undefined) ESTADO.ultimaChecagemCancelamentoEm = 0;

  const UM_DIA_MS = 24 * 60 * 60 * 1000;
  const TRINTA_DIAS_MS = 30 * UM_DIA_MS;
  const MAX_CONSULTAS_POR_CICLO = 20;

  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    let produtos = [];
    let pontoOriginal = ESTADO.pontoDeSincronizacao || 0;
    let pontoRetornado;
    let sincronizacaoCompleta = false;

    const precisaSyncPeriodica = pontoOriginal !== 0 && (Date.now() - ESTADO.ultimaSyncCompletaEm > UM_DIA_MS);

    // ============================================================
    // 1. BUSCA DE PRODUTOS
    // ------------------------------------------------------------
    // - ponto=0 (primeira execução) OU 24h+ sem uma sync completa:
    //   busca tudo de uma vez, como rede de segurança periódica.
    // - Caso contrário: busca incremental a partir do ponto salvo.
    //   "Sem novidades" NÃO conta como falha — só erros de verdade
    //   entram no contador de 3 tentativas antes de forçar uma
    //   sincronização completa de recuperação.
    // ============================================================
    if (pontoOriginal === 0 || precisaSyncPeriodica) {
      const motivo = pontoOriginal === 0
        ? 'primeira execução'
        : `mais de 24h sem sync completa (${((Date.now() - ESTADO.ultimaSyncCompletaEm) / 3600000).toFixed(1)}h)`;
      console.log(`🔄 Buscando todos os produtos (ponto=0) — ${motivo}.`);
      const resposta = await buscarProdutosHiper(tokenHiper, 0);
      produtos = resposta.produtos || [];
      pontoRetornado = resposta.pontoDeSincronizacao;
      sincronizacaoCompleta = true;
      ESTADO.falhasPonto = 0;
    } else {
      try {
        const resposta = await buscarProdutosHiper(tokenHiper, pontoOriginal);
        produtos = resposta.produtos || [];
        pontoRetornado = resposta.pontoDeSincronizacao;
        ESTADO.falhasPonto = 0;
        if (resposta.semNovidades) {
          console.log(`ℹ️ Nada novo desde o ponto ${pontoOriginal}. Seguindo para checagem de pedidos.`);
        }
      } catch (erro) {
        ESTADO.falhasPonto = (ESTADO.falhasPonto || 0) + 1;
        console.error(`❌ Erro ao buscar produtos: ${erro.message}. Falhas: ${ESTADO.falhasPonto}/3`);

        if (ESTADO.falhasPonto < 3) {
          console.log(`⏳ Tentativa ${ESTADO.falhasPonto}/3. Aguardando próxima execução.`);
          await salvarEstado(ESTADO);
          return;
        }

        console.warn(`🔄 Forçando sincronização completa (ponto=0) após 3 erros consecutivos.`);
        const resposta = await buscarProdutosHiper(tokenHiper, 0);
        produtos = resposta.produtos || [];
        pontoRetornado = resposta.pontoDeSincronizacao;
        sincronizacaoCompleta = true;
        ESTADO.falhasPonto = 0;
      }
    }

    if (sincronizacaoCompleta) {
      ESTADO.ultimaSyncCompletaEm = Date.now();
    }

    if (produtos.length > 0) {
      console.log(`✅ ${produtos.length} produtos encontrados no Hiper.`);
    } else {
      console.log('ℹ️ Nenhum produto para processar neste ciclo.');
    }

    // ============================================================
    // 2. ATUALIZA MAPA SKU
    // ============================================================
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => { if (v.codigoDeBarras) ESTADO.mapaSkuHiper[v.codigoDeBarras] = v.id; });
      } else {
        if (produto.codigoDeBarras) ESTADO.mapaSkuHiper[produto.codigoDeBarras] = produto.id;
      }
    }
    const mapaSkuHiper = ESTADO.mapaSkuHiper;

    // ============================================================
    // 3. ARQUIVAMENTO
    // ------------------------------------------------------------
    // Sync completa: compara mapa inteiro x lista retornada (segura
    // porque a lista é o snapshot completo). Sync incremental: só
    // arquiva quem veio no próprio lote marcado como removido/
    // inativo — nunca por ausência na lista.
    // ============================================================
    let arquivados = 0;

    if (sincronizacaoCompleta) {
      if (produtos.length === 0) {
        console.warn('⚠️ Sincronização completa retornou 0 produtos — isso é incomum. Por segurança, nada será arquivado neste ciclo. Vale checar a integração com o Hiper se isso persistir.');
      } else {
        const idsAtivos = new Set();
        for (const produto of produtos) {
          if (!produto.removido && produto.ativo) idsAtivos.add(produto.id);
        }
        const mapaAtual = { ...ESTADO.produtosMap };
        for (const hiperId of Object.keys(mapaAtual)) {
          if (!idsAtivos.has(hiperId)) {
            const ok = await arquivarSeMapeado(tokenShopify, ESTADO, hiperId, 'não está mais ativo no Hiper (sync completa)');
            if (ok) arquivados++;
            await sleep(300);
          }
        }
      }
    } else {
      for (const produto of produtos) {
        if (produto.removido || !produto.ativo) {
          const ok = await arquivarSeMapeado(tokenShopify, ESTADO, produto.id, 'foi marcado como removido/inativo no Hiper');
          if (ok) arquivados++;
          await sleep(300);
        }
      }
    }

    // ============================================================
    // 4. CRIAR/ATUALIZAR PRODUTOS ATIVOS
    // ------------------------------------------------------------
    // Antes de atualizar um produto já mapeado, checamos a
    // descrição ATUAL na Shopify. Se ela for diferente da última
    // que o próprio robô escreveu, é porque alguém editou
    // manualmente — nesse caso não sobrescrevemos a descrição (mas
    // preço, estoque e variantes continuam sendo atualizados
    // normalmente).
    // ============================================================
    let criados = 0;
    let atualizados = 0;
    if (produtos.length > 0) console.log('\n🚀 Criando/atualizando produtos...');

    for (const produto of produtos) {
      if (produto.removido || !produto.ativo) continue; // já tratado no arquivamento acima
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

        const mapaEntry = ESTADO.produtosMap[produto.id];
        if (mapaEntry) {
          console.log(`📦 Produto "${produto.nome}" já mapeado (Shopify ID: ${mapaEntry.shopifyId}). Atualizando...`);
          const produtoExistente = mapaParaProdutoExistente(mapaEntry);

          let preservarDescricao = false;
          let preservarImagens = false;
          try {
            const dadosAtuais = await buscarDadosAtuaisProdutoShopify(tokenShopify, mapaEntry.shopifyId);
            if (mapaEntry.ultimaDescricaoEnviada !== undefined && dadosAtuais.body_html !== mapaEntry.ultimaDescricaoEnviada) {
              preservarDescricao = true;
              console.log(`✋ Descrição de "${produto.nome}" foi editada manualmente na Shopify — mantendo como está.`);
            }
            if (dadosAtuais.images && dadosAtuais.images.length > 0 && !mapaEntry.imagensEnviadasPeloRobo) {
              preservarImagens = true;
            }
          } catch (erro) {
            console.warn(`⚠️ Não foi possível checar os dados atuais de "${produto.nome}" na Shopify: ${erro.message}. Seguindo com o comportamento padrão (sobrescreve).`);
          }

          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente, { preservarDescricao, preservarImagens });
          if (atualizado) {
            const novaEntry = extrairMapaProduto(atualizado);
            novaEntry.ultimaDescricaoEnviada = preservarDescricao ? mapaEntry.ultimaDescricaoEnviada : (produto.descricao || '');
            novaEntry.imagensEnviadasPeloRobo = preservarImagens ? mapaEntry.imagensEnviadasPeloRobo : true;
            ESTADO.produtosMap[produto.id] = novaEntry;
            atualizados++;
          }
        } else {
          let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
          if (!existe) {
            existe = await buscarProdutoPorSKU(tokenShopify, sku);
          }
          if (existe) {
            console.log(`📦 Produto "${produto.nome}" encontrado via busca (SKU: ${sku}). Atualizando e mapeando...`);
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe, {});
            if (atualizado) {
              const novaEntry = extrairMapaProduto(atualizado);
              novaEntry.ultimaDescricaoEnviada = produto.descricao || '';
              novaEntry.imagensEnviadasPeloRobo = true;
              ESTADO.produtosMap[produto.id] = novaEntry;
              atualizados++;
            }
          } else {
            console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              const novaEntry = extrairMapaProduto(novo);
              novaEntry.ultimaDescricaoEnviada = produto.descricao || '';
              novaEntry.imagensEnviadasPeloRobo = true;
              ESTADO.produtosMap[produto.id] = novaEntry;
              criados++;
            }
          }
        }
        await salvarEstado(ESTADO);
      } catch (erro) {
        console.error(`❌ Erro ao processar "${produto.nome}":`, erro.message);
      }
      await sleep(400);
    }

    // ============================================================
    // 5. ATUALIZA PONTO DE SINCRONIZAÇÃO
    // ------------------------------------------------------------
    // Confia sempre no valor que o HIPER devolveu. Nunca recalcula
    // localmente e nunca bloqueia a atualização comparando com o
    // valor antigo.
    // ============================================================
    if (pontoRetornado !== undefined && pontoRetornado !== null && !isNaN(pontoRetornado)) {
      if (pontoRetornado !== ESTADO.pontoDeSincronizacao) {
        console.log(`📌 Ponto de sincronização: ${ESTADO.pontoDeSincronizacao} → ${pontoRetornado}`);
        ESTADO.pontoDeSincronizacao = pontoRetornado;
      } else {
        console.log(`📌 Ponto de sincronização inalterado (${pontoRetornado}).`);
      }
    } else {
      console.warn('⚠️ Hiper não retornou um pontoDeSincronizacao válido nesta chamada — mantendo o valor atual.');
    }

    console.log(`\n--- SINC. PRODUTOS CONCLUÍDA ---`);
    console.log(`📦 ${criados} produtos CRIADOS.`);
    console.log(`🔄 ${atualizados} produtos ATUALIZADOS.`);
    console.log(`🗑️ ${arquivados} produtos ARQUIVADOS (removidos do Hiper).`);

    await salvarEstado(ESTADO);

    // ============================================================
    // 6. PEDIDOS NOVOS (Shopify → Hiper)
    // ------------------------------------------------------------
    // Resolve CPF/CNPJ, forma de pagamento e código IBGE reais
    // antes de enviar. Salva o progresso a CADA pedido processado
    // (não só no fim do lote) para não reenviar em duplicidade se
    // o processo cair no meio do caminho.
    // ============================================================
    const pedidos = await buscarPedidosShopify(tokenShopify, ESTADO.ultimoPedidoId || 0);
    let enviados = 0;

    for (const pedido of pedidos) {
      try {
        if (pedido.cancelled_at) {
          console.log(`⏭️ Pedido #${pedido.order_number} já está cancelado na Shopify. Não enviando ao Hiper.`);
        } else {
          const enderecoEntrega = pedido.shipping_address;
          const enderecoCobranca = pedido.billing_address || enderecoEntrega;

          const [codigoIbgeEntrega, codigoIbgeCobranca, documentoCliente] = await Promise.all([
            obterCodigoIbge(enderecoEntrega?.province_code, enderecoEntrega?.city),
            obterCodigoIbge(enderecoCobranca?.province_code, enderecoCobranca?.city),
            buscarCpfCnpjDoPedido(tokenShopify, pedido.id)
          ]);
          const idMeioDePagamento = mapearMeioDePagamento(pedido);

          console.log(`🔎 Pedido #${pedido.order_number}: documento resolvido = "${documentoCliente || '(não encontrado)'}" | IBGE entrega = ${codigoIbgeEntrega || '(não resolvido)'} | IBGE cobrança = ${codigoIbgeCobranca || '(não resolvido)'} | meio de pagamento = ${idMeioDePagamento}`);

          if (!codigoIbgeEntrega || !documentoCliente) {
            console.warn(`⚠️ Pedido #${pedido.order_number}: ${!documentoCliente ? 'CPF/CNPJ não encontrado' : ''}${!documentoCliente && !codigoIbgeEntrega ? ' e ' : ''}${!codigoIbgeEntrega ? `código IBGE não resolvido para "${enderecoEntrega?.city}/${enderecoEntrega?.province_code}"` : ''}. O Hiper provavelmente vai rejeitar este pedido — verifique manualmente se persistir.`);
          }

          const resultado = await enviarPedidoParaHiper(tokenHiper, pedido, mapaSkuHiper, {
            documentoCliente,
            idMeioDePagamento,
            codigoIbgeEntrega,
            codigoIbgeCobranca
          });

          if (resultado) {
            enviados++;
            ESTADO.pedidosMap[pedido.id] = {
              hiperPedidoId: resultado.id,
              orderNumber: pedido.order_number,
              cancelado: false,
              faturado: false,
              enviadoEm: Date.now()
            };
          }
        }
      } catch (erro) {
        console.error(`❌ Erro ao enviar pedido #${pedido.order_number}:`, erro.message);
      }

      if (pedido.id > (ESTADO.ultimoPedidoId || 0)) {
        ESTADO.ultimoPedidoId = pedido.id;
      }
      await salvarEstado(ESTADO); // salva a cada pedido — evita duplicidade em caso de crash no meio do lote
      await sleep(300);
    }
    console.log(`\n--- SINC. PEDIDOS CONCLUÍDA ---`);
    console.log(`📦 ${enviados} pedidos enviados para o Hiper.`);

    // ============================================================
    // 7. CANCELAMENTOS NA SHOPIFY → PROPAGA PRO HIPER
    // ============================================================
    try {
      const desdeCancelamento = new Date(ESTADO.ultimaChecagemCancelamentoEm || (Date.now() - UM_DIA_MS)).toISOString();
      const pedidosCancelados = await buscarPedidosCanceladosShopify(tokenShopify, desdeCancelamento);

      for (const pedidoCancelado of pedidosCancelados) {
        const entry = ESTADO.pedidosMap[pedidoCancelado.id];
        if (entry && !entry.cancelado) {
          try {
            await cancelarPedidoHiper(tokenHiper, entry.hiperPedidoId);
            entry.cancelado = true;
            console.log(`🚫 Pedido #${entry.orderNumber} cancelado na Shopify → cancelado no Hiper também.`);
          } catch (erro) {
            console.error(`❌ Erro ao cancelar pedido ${entry.hiperPedidoId} no Hiper:`, erro.message);
          }
          await sleep(300);
        }
      }
      ESTADO.ultimaChecagemCancelamentoEm = Date.now();
      await salvarEstado(ESTADO);
    } catch (erro) {
      console.error(`❌ Erro ao checar cancelamentos na Shopify: ${erro.message}`);
    }

    // ============================================================
    // 8. STATUS DOS PEDIDOS NO HIPER → REFLETE NA SHOPIFY
    // ------------------------------------------------------------
    // Consulta só pedidos ainda "em aberto" (não cancelados, sem NF
    // ainda) e enviados nos últimos 30 dias — evita polling infinito
    // de pedidos antigos e limita o volume de chamadas por ciclo.
    // Se o Hiper reportar cancelamento, NÃO cancela automaticamente
    // na Shopify (envolve estorno) — só marca com uma tag pra revisão
    // manual.
    // ============================================================
    const pendentes = Object.entries(ESTADO.pedidosMap)
      .filter(([, p]) => !p.cancelado && !p.faturado && (Date.now() - (p.enviadoEm || 0)) < TRINTA_DIAS_MS)
      .slice(0, MAX_CONSULTAS_POR_CICLO);

    for (const [shopifyOrderId, entry] of pendentes) {
      try {
        const status = await consultarPedidoHiper(tokenHiper, entry.hiperPedidoId);

        if (status.cancelado && !entry.cancelado) {
          entry.cancelado = true;
          await adicionarTagAoPedidoShopify(tokenShopify, shopifyOrderId, 'Hiper-Cancelado');
          console.warn(`🚫 Pedido #${entry.orderNumber} foi cancelado no HIPER. Tag adicionada na Shopify — revise manualmente se precisa estornar.`);
        }

        const eventoComNota = (status.eventos || []).find(e => e.chaveDocumentoFiscal);
        if (eventoComNota && !entry.faturado) {
          entry.faturado = true;
          await adicionarTagAoPedidoShopify(tokenShopify, shopifyOrderId, 'Hiper-Faturado');
          console.log(`🧾 Pedido #${entry.orderNumber} faturado no Hiper (código: ${status.codigoDoPedidoDeVenda}).`);
        }
      } catch (erro) {
        console.error(`❌ Erro ao consultar pedido ${entry.hiperPedidoId}:`, erro.message);
      }
      await sleep(300);
    }

    await salvarEstado(ESTADO);
    console.log(`\n✅ ESTADO SALVO NO UPSTASH (${Object.keys(ESTADO.produtosMap).length} produtos mapeados, ${Object.keys(ESTADO.pedidosMap).length} pedidos rastreados).`);
  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    await salvarEstado(ESTADO).catch(() => {});
  }
}

module.exports = { sincronizar };

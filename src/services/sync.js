// src/services/sync.js
const request = require('../utils/request.js');
const { carregarEstado, salvarEstado } = require('../utils/stateStore.js');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarPedidosShopify,
  sleep
} = require('./shopify.js');

// ============================================================
// FUNÇÕES AUXILIARES PARA MAPEAMENTO
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

  const UM_DIA_MS = 24 * 60 * 60 * 1000;

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
    //   busca tudo de uma vez, como rede de segurança periódica
    //   (protege contra o caso de "sem novidades" na verdade
    //   esconder um ponto realmente inválido/expirado no Hiper).
    // - Caso contrário: busca incremental a partir do ponto salvo.
    //   "Sem novidades" (ver hiper.js) NÃO conta como falha — só
    //   erros de verdade (rede, autenticação, resposta inesperada)
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
    // O endpoint incremental só devolve o que MUDOU desde o último
    // ponto — não a lista completa de produtos ativos. Por isso só
    // podemos comparar "mapa inteiro x retornados" (e arquivar quem
    // sumiu) numa sincronização COMPLETA. Numa incremental,
    // arquivamos apenas quem veio no próprio lote marcado como
    // removido/inativo — nunca por ausência na lista, porque a
    // ausência aí não significa que o produto sumiu, só que ele não
    // mudou desde o último ponto.
    // ============================================================
    let arquivados = 0;

    if (sincronizacaoCompleta) {
      if (produtos.length === 0) {
        console.warn('⚠️ Sincronização completa retornou 0 produtos — isso é incomum. Por segurança, nada será arquivado neste ciclo (evita apagar o catálogo inteiro por engano). Vale checar a integração com o Hiper se isso persistir.');
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
          const atualizado = await atualizarProdutoShopify(tokenShopify, produto, produtoExistente);
          if (atualizado) {
            ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
            atualizados++;
          }
        } else {
          let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
          if (!existe) {
            existe = await buscarProdutoPorSKU(tokenShopify, sku);
          }
          if (existe) {
            console.log(`📦 Produto "${produto.nome}" encontrado via busca (SKU: ${sku}). Atualizando e mapeando...`);
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(atualizado);
              atualizados++;
            }
          } else {
            console.log(`🆕 Produto "${produto.nome}" não encontrado (SKU: ${sku}). Criando...`);
            const novo = await criarProdutoShopify(tokenShopify, produto);
            if (novo) {
              ESTADO.produtosMap[produto.id] = extrairMapaProduto(novo);
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
    // Regra única: confiamos sempre no valor que o HIPER devolveu.
    // Nunca recalculamos localmente (ex: com produtos.length) e
    // nunca bloqueamos a atualização comparando com o valor antigo
    // — o ponto é um cursor controlado pelo Hiper, não um contador
    // nosso, então um valor "menor" não é necessariamente retrocesso.
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

    // ============================================================
    // 6. SALVA ESTADO (antes dos pedidos)
    // ============================================================
    await salvarEstado(ESTADO);

    // ============================================================
    // 7. PEDIDOS (sempre roda, mesmo em ciclos sem novidade de produto)
    // ============================================================
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
      await sleep(300);
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
        await sleep(300);
      }
    }

    await salvarEstado(ESTADO);
    console.log(`\n✅ ESTADO SALVO NO UPSTASH (${Object.keys(ESTADO.produtosMap).length} produtos mapeados).`);
  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    await salvarEstado(ESTADO).catch(() => {});
  }
}

module.exports = { sincronizar };

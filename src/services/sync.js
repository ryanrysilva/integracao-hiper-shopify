// src/services/sync.js
const fs = require('fs');
const { gerarTokenHiper, buscarProdutosHiper, enviarPedidoParaHiper, consultarPedidoHiper, cancelarPedidoHiper } = require('./hiper.js');
const {
  gerarTokenShopify,
  buscarProdutoPorSKU,
  criarProdutoShopify,
  atualizarProdutoShopify,
  arquivarProdutoShopify,
  buscarPedidosShopify
} = require('./shopify.js');

// ============================================================
// CARREGAR ESTADO (com mapaSkuHiper persistente)
// ============================================================
let ESTADO = { 
  ultimoPedidoId: 0, 
  pontoDeSincronizacao: 0,
  mapaSkuHiper: {} // <-- NOVO: mapa cumulativo SKU -> ID do Hiper
};

if (fs.existsSync('state.json')) {
  try {
    const dados = JSON.parse(fs.readFileSync('state.json', 'utf8'));
    ESTADO.ultimoPedidoId = dados.ultimoPedidoId || 0;
    ESTADO.pontoDeSincronizacao = dados.pontoDeSincronizacao || 0;
    ESTADO.mapaSkuHiper = dados.mapaSkuHiper || {};
  } catch (e) {
    console.warn('⚠️ state.json corrompido, resetando...');
  }
}

// ============================================================
// FUNÇÃO PARA BUSCAR PRODUTO PELO METAFIELD (GRAPHQL CORRIGIDO)
// ============================================================
async function buscarProdutoPorMetafield(token, hiperId) {
  console.log(`🔍 Buscando produto pelo metafield: hiper.product_id = ${hiperId}`);
  
  const query = `{
    products(first: 1, query: "metafields.hiper.product_id:'${hiperId}'") {
      edges {
        node {
          id
          title
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    }
  }`;

  const request = require('../utils/request.js');
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

    // Validação extra para garantir que o metafield bate com o hiperId
    const metafieldConfere = metafields.some(
      mf => mf.namespace === 'hiper' && mf.key === 'product_id' && mf.value === hiperId
    );
    if (!metafieldConfere) {
      console.warn(`⚠️ Produto retornado não bate com hiperId ${hiperId}. Ignorando.`);
      return null;
    }

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
    console.error(`❌ Erro ao buscar metafield ${hiperId}:`, err.message);
    return null;
  }
}

// ============================================================
// FUNÇÃO PARA OBTER IBGE A PARTIR DO CEP (VIA ViaCEP)
// ============================================================
async function obterIbgePorCep(cep) {
  if (!cep || cep.length < 8) return null;
  try {
    const https = require('https');
    const url = `https://viacep.com.br/ws/${cep}/json/`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ibge) {
              resolve(parseInt(parsed.ibge));
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (e) {
    console.warn(`⚠️ Erro ao buscar IBGE para CEP ${cep}:`, e.message);
    return null;
  }
}

// ============================================================
// FUNÇÃO PARA PROCESSAR UM PEDIDO (com correções)
// ============================================================
async function processarPedido(tokenHiper, pedidoShopify, mapaSkuHiperCompleto) {
  console.log(`🔄 Enviando pedido #${pedidoShopify.order_number} para o Hiper...`);

  // 1. Cliente: tenta obter CPF do note_attributes
  let documento = '00000000000'; // fallback
  if (pedidoShopify.note_attributes) {
    const cpfAttr = pedidoShopify.note_attributes.find(a => a.name === 'cpf' || a.name === 'documento');
    if (cpfAttr) documento = cpfAttr.value.replace(/\D/g, '');
  }
  // Se ainda não tem, tenta obter do customer (alguns apps salvam como metafield)
  if (documento === '00000000000' && pedidoShopify.customer) {
    // Você pode buscar metafields do cliente aqui se necessário
  }

  const cliente = {
    documento: documento,
    email: pedidoShopify.email || pedidoShopify.customer?.email || 'cliente@email.com',
    inscricaoEstadual: '',
    nomeDoCliente: pedidoShopify.customer?.first_name + ' ' + pedidoShopify.customer?.last_name || 'Cliente',
    nomeFantasia: ''
  };

  // 2. Endereço de entrega (com IBGE via CEP)
  const shipping = pedidoShopify.shipping_address || {};
  const cep = (shipping.zip || '').replace(/\D/g, '');
  let codigoIbge = 0;
  if (cep.length === 8) {
    const ibge = await obterIbgePorCep(cep);
    if (ibge) codigoIbge = ibge;
  }

  const enderecoEntrega = {
    bairro: shipping.city || '',
    cep: cep,
    codigoIbge: codigoIbge,
    complemento: shipping.address2 || '',
    logradouro: shipping.address1 || '',
    numero: shipping.address1?.match(/\d+/) ? shipping.address1.match(/\d+/)[0] : '0'
  };

  // 3. Endereço de cobrança (pode ser igual ao de entrega)
  const billing = pedidoShopify.billing_address || shipping;
  const cepCobranca = (billing.zip || '').replace(/\D/g, '');
  let codigoIbgeCobranca = 0;
  if (cepCobranca.length === 8) {
    const ibge = await obterIbgePorCep(cepCobranca);
    if (ibge) codigoIbgeCobranca = ibge;
  }

  const enderecoCobranca = {
    bairro: billing.city || '',
    cep: cepCobranca,
    codigoIbge: codigoIbgeCobranca,
    complemento: billing.address2 || '',
    logradouro: billing.address1 || '',
    numero: billing.address1?.match(/\d+/) ? billing.address1.match(/\d+/)[0] : '0'
  };

  // 4. Itens (usando mapaSkuHiperCompleto)
  const itens = [];
  for (const item of pedidoShopify.line_items || []) {
    const sku = item.sku || '';
    const produtoId = mapaSkuHiperCompleto[sku];
    if (!produtoId) {
      console.warn(`⚠️ SKU ${sku} não encontrado no mapa Hiper. Pulando item...`);
      continue;
    }
    itens.push({
      produtoId: produtoId,
      quantidade: item.quantity || 1,
      precoUnitarioBruto: parseFloat(item.price) || 0,
      precoUnitarioLiquido: parseFloat(item.price) || 0
    });
  }

  if (itens.length === 0) {
    console.warn(`⚠️ Pedido #${pedidoShopify.order_number} não tem itens válidos. Ignorando.`);
    return null;
  }

  // 5. Meios de Pagamento (mapeamento baseado no gateway)
  // Mapeamento simples: se for 'credit_card' ou 'shopify_payments' → 4; 'pix' → 12; 'cash' → 1 etc.
  const gateway = pedidoShopify.gateway || '';
  let idMeioDePagamento = 4; // default: cartão de crédito
  if (gateway.includes('pix') || gateway.includes('Pix')) idMeioDePagamento = 12;
  else if (gateway.includes('boleto')) idMeioDePagamento = 1; // pode ajustar
  else if (gateway.includes('debit')) idMeioDePagamento = 5;

  const total = parseFloat(pedidoShopify.total_price) || 0;
  const meiosPagamento = [{
    idMeioDePagamento: idMeioDePagamento,
    parcelas: 1,
    valor: total
  }];

  // 6. Frete
  let valorFrete = 0;
  if (pedidoShopify.shipping_lines && pedidoShopify.shipping_lines.length > 0) {
    valorFrete = parseFloat(pedidoShopify.shipping_lines[0].price) || 0;
  }

  // 7. Marketplace (opcional – só enviar se a loja for de SC)
  // Você pode obter o estado da filial via configuração (ex: variável de ambiente)
  const estadoLoja = process.env.LOJA_ESTADO || 'SP';
  const marketplace = estadoLoja === 'SC' ? {
    Cnpj: process.env.MARKETPLACE_CNPJ || '12605982000124',
    Nome: process.env.MARKETPLACE_NOME || 'Hiper'
  } : undefined;

  const payloadHiper = {
    cliente,
    enderecoDeCobranca,
    enderecoDeEntrega,
    itens,
    meiosDePagamento,
    numeroPedidoDeVenda: pedidoShopify.order_number.toString(),
    observacaoDoPedidoDeVenda: `Pedido Shopify #${pedidoShopify.order_number}`,
    valorDoFrete: valorFrete
  };

  if (marketplace) {
    payloadHiper.Marketplace = marketplace;
  }

  // 8. Envia para o Hiper
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: '/api/v1/pedido-de-venda/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenHiper}`
    }
  };

  const request = require('../utils/request.js');
  return request(opcoes, JSON.stringify(payloadHiper)).then(res => {
    if (res.errors && res.errors.length > 0) throw new Error(res.errors.join(', '));
    console.log(`✅ Pedido #${pedidoShopify.order_number} enviado para o Hiper! ID: ${res.id}`);
    return { id: res.id, orderNumber: pedidoShopify.order_number };
  });
}

// ============================================================
// FUNÇÃO PRINCIPAL DE SINCRONIZAÇÃO
// ============================================================
async function sincronizar() {
  console.log('\n🚀 INICIANDO SINCRONIZAÇÃO COMPLETA (PRODUTOS + PEDIDOS)...\n');
  
  try {
    const tokenHiper = await gerarTokenHiper();
    const tokenShopify = await gerarTokenShopify();

    // --- PRODUTOS ---
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

    // --- ATUALIZA MAPA SKU (MERGE CUMULATIVO) ---
    const mapaNovo = {};
    for (const produto of produtos) {
      if (produto.variacao && produto.variacao.length > 0) {
        produto.variacao.forEach(v => {
          if (v.codigoDeBarras) mapaNovo[v.codigoDeBarras] = v.id;
        });
      } else {
        if (produto.codigoDeBarras) mapaNovo[produto.codigoDeBarras] = produto.id;
      }
    }
    // Merge: adiciona/atualiza sem perder os que já existiam
    ESTADO.mapaSkuHiper = { ...ESTADO.mapaSkuHiper, ...mapaNovo };
    const mapaSkuHiperCompleto = ESTADO.mapaSkuHiper;

    let criados = 0;
    let atualizados = 0;
    let arquivados = 0;
    const skusProcessados = new Set();

    // Limpeza de produtos antigos (sem metafield)
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
        let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
        if (!existe) {
          existe = await buscarProdutoPorSKU(tokenShopify, sku);
        }
        if (existe) {
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

    // Criação/Atualização de produtos
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

        if (skusProcessados.has(sku)) {
          console.log(`⏩ SKU ${sku} já processado. Pulando...`);
          continue;
        }

        let existe = await buscarProdutoPorMetafield(tokenShopify, produto.id);
        if (!existe) {
          existe = await buscarProdutoPorSKU(tokenShopify, sku);
        }

        if (existe) {
          console.log(`📦 Produto "${produto.nome}" encontrado (SKU: ${sku}). Atualizando...`);
          const temMetafield = existe.metafields && existe.metafields.some(mf => 
            mf.namespace === 'hiper' && mf.key === 'product_id'
          );
          if (temMetafield) {
            const atualizado = await atualizarProdutoShopify(tokenShopify, produto, existe);
            if (atualizado) {
              atualizados++;
              skusProcessados.add(sku);
            }
          } else {
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

    // Atualiza ponto de sincronização apenas se houver mudanças
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

    // --- PEDIDOS (usando mapaSkuHiperCompleto) ---
    const pedidos = await buscarPedidosShopify(tokenShopify, ESTADO.ultimoPedidoId || 0);
    let enviados = 0;
    const pedidosEnviados = [];
    for (const pedido of pedidos) {
      try {
        const resultado = await processarPedido(tokenHiper, pedido, mapaSkuHiperCompleto);
        if (resultado) {
          enviados++;
          pedidosEnviados.push(resultado);
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

    // Salva estado (incluindo mapaSkuHiper)
    fs.writeFileSync('state.json', JSON.stringify(ESTADO, null, 2));
    console.log(`\n✅ ESTADO SALVO (com mapa de ${Object.keys(ESTADO.mapaSkuHiper).length} SKUs).`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
    // Aqui você pode adicionar um webhook para notificar erro (Slack, Discord, etc.)
  }
}

module.exports = { sincronizar };

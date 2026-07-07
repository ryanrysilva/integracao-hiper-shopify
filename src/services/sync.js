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

let ESTADO = { 
  ultimoPedidoId: 0, 
  pontoDeSincronizacao: 0,
  mapaSkuHiper: {}
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
// FUNÇÃO PARA BUSCAR PRODUTO PELO METAFIELD (VERSÃO ROBUSTA)
// ============================================================
async function buscarProdutoPorMetafield(token, hiperId) {
  console.log(`🔍 Buscando produto pelo metafield: hiper.product_id = ${hiperId}`);

  // Abordagem: busca produtos com metafield namespace=hiper e key=product_id, sem filtrar pelo valor
  const query = `{
    products(first: 10, query: "metafields.hiper.product_id:*") {
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
    if (edges.length === 0) {
      console.log(`ℹ️ Nenhum produto com metafield hiper.product_id encontrado.`);
      return null;
    }

    // Itera sobre os produtos encontrados e verifica o valor do metafield
    for (const edge of edges) {
      const product = edge.node;
      const metafields = product.metafields.edges.map(edge => ({
        namespace: edge.node.namespace,
        key: edge.node.key,
        value: edge.node.value
      }));

      const metafieldConfere = metafields.some(
        mf => mf.namespace === 'hiper' && mf.key === 'product_id' && mf.value === hiperId
      );

      if (metafieldConfere) {
        console.log(`✅ Produto encontrado pelo metafield: ${product.title} (ID: ${product.id})`);
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
      }
    }

    console.warn(`⚠️ Nenhum produto com metafield igual a "${hiperId}" foi encontrado.`);
    return null;
  } catch (err) {
    console.error(`❌ Erro ao buscar metafield ${hiperId}:`, err.message);
    return null;
  }
}

// ============================================================
// FUNÇÃO PARA OBTER IBGE A PARTIR DO CEP (ViaCEP)
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
// FUNÇÃO PARA PROCESSAR UM PEDIDO
// ============================================================
async function processarPedido(tokenHiper, pedidoShopify, mapaSkuHiperCompleto) {
  console.log(`🔄 Enviando pedido #${pedidoShopify.order_number} para o Hiper...`);

  let documento = '00000000000';
  if (pedidoShopify.note_attributes) {
    const cpfAttr = pedidoShopify.note_attributes.find(a => a.name === 'cpf' || a.name === 'documento');
    if (cpfAttr) documento = cpfAttr.value.replace(/\D/g, '');
  }

  const cliente = {
    documento: documento,
    email: pedidoShopify.email || pedidoShopify.customer?.email || 'cliente@email.com',
    inscricaoEstadual: '',
    nomeDoCliente: pedidoShopify.customer?.first_name + ' ' + pedidoShopify.customer?.last_name || 'Cliente',
    nomeFantasia: ''
  };

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

  const gateway = pedidoShopify.gateway || '';
  let idMeioDePagamento = 4;
  if (gateway.includes('pix') || gateway.includes('Pix')) idMeioDePagamento = 12;
  else if (gateway.includes('boleto')) idMeioDePagamento = 1;
  else if (gateway.includes('debit')) idMeioDePagamento = 5;

  const total = parseFloat(pedidoShopify.total_price) || 0;
  const meiosPagamento = [{
    idMeioDePagamento: idMeioDePagamento,
    parcelas: 1,
    valor: total
  }];

  let valorFrete = 0;
  if (pedidoShopify.shipping_lines && pedidoShopify.shipping_lines.length > 0) {
    valorFrete = parseFloat(pedidoShopify.shipping_lines[0].price) || 0;
  }

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

  const request = require('../utils/request.js');
  const opcoes = {
    hostname: 'ms-ecommerce.hiper.com.br',
    path: '/api/v1/pedido-de-venda/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenHiper}`
    }
  };

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

    // Atualiza mapa SKU (cumulativo)
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

    fs.writeFileSync('state.json', JSON.stringify(ESTADO, null, 2));
    console.log(`\n✅ ESTADO SALVO (com mapa de ${Object.keys(ESTADO.mapaSkuHiper).length} SKUs).`);

  } catch (erro) {
    console.error('❌ ERRO NA SINCRONIZAÇÃO:', erro.message);
  }
}

module.exports = { sincronizar };

// ============================================================
// ATUALIZAR PRODUTO (APENAS PREÇO/OPÇÕES, SEM ENVIAR OPTIONS)
// ============================================================
async function atualizarProdutoShopify(token, produtoHiper, produtoExistente) {
  console.log(`🔄 ATUALIZANDO produto "${produtoHiper.nome}" (preço e opções)...`);

  if (!produtoExistente || !produtoExistente.variants || produtoExistente.variants.length === 0) {
    console.error(`❌ Produto "${produtoHiper.nome}" não tem variantes válidas. Não é possível atualizar.`);
    return null;
  }

  // 1. Remove a Default Title (se existir)
  const defaultVariant = produtoExistente.variants.find(v => v.title === 'Default Title');
  if (defaultVariant) {
    console.log(`🔁 Excluindo "Default Title" (ID: ${defaultVariant.id})...`);
    try {
      const opcoes = {
        hostname: `${CONFIG.shopify.loja}.myshopify.com`,
        path: `/admin/api/2026-07/variants/${defaultVariant.id}.json`,
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': token }
      };
      await request(opcoes);
      console.log(`✅ "Default Title" excluída.`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Recarrega o produto para pegar as variantes atualizadas
      const recarregado = await buscarProdutoPorSKU(token, produtoHiper.codigoDeBarras || produtoHiper.variacao?.[0]?.codigoDeBarras);
      if (recarregado) produtoExistente = recarregado;
    } catch (erro) {
      console.warn(`⚠️ Erro ao excluir Default Title: ${erro.message}. Continuando...`);
    }
  }

  const temVariacoes = produtoHiper.variacao && produtoHiper.variacao.length > 0;
  const sku = produtoHiper.codigoDeBarras || (temVariacoes ? produtoHiper.variacao[0].codigoDeBarras : '');

  // Mapeia variantes existentes
  const mapaExistente = {};
  produtoExistente.variants.forEach(v => { mapaExistente[v.sku] = v; });

  let variantsAtualizados = [];

  if (temVariacoes) {
    const tipoVariacaoA = produtoHiper.variacao[0]?.tipoVariacaoA || 'Opção 1';
    const tipoVariacaoB = produtoHiper.variacao[0]?.tipoVariacaoB || null;

    for (const variacaoHiper of produtoHiper.variacao) {
      const varSku = variacaoHiper.codigoDeBarras || '';
      const existente = mapaExistente[varSku];
      const variant = {
        sku: varSku,
        price: produtoHiper.preco.toString(),
        option1: variacaoHiper.nomeVariacaoA || 'Padrão'
      };
      if (tipoVariacaoB) {
        variant.option2 = variacaoHiper.nomeVariacaoB || 'Padrão';
      }
      if (existente) {
        variant.id = existente.id;
        // Atualiza estoque via Inventory API
        if (existente.inventory_item_id) {
          await atualizarEstoqueShopify(token, existente.inventory_item_id, Math.floor(variacaoHiper.quantidadeEmEstoque || 0))
            .catch(err => console.warn(`⚠️ Erro ao atualizar estoque da variante ${existente.id}: ${err.message}`));
        } else {
          console.warn(`⚠️ Variante ${existente.id} não tem inventory_item_id. Estoque não atualizado.`);
        }
      } else {
        // Se a variante não existe, será criada (estoque definido na criação)
        variant.inventory_quantity = Math.floor(variacaoHiper.quantidadeEmEstoque || 0);
      }
      variantsAtualizados.push(variant);
    }
  } else {
    const existente = mapaExistente[sku];
    const variant = {
      sku: sku,
      price: produtoHiper.preco.toString(),
      option1: produtoHiper.nome
    };
    if (existente) {
      variant.id = existente.id;
      if (existente.inventory_item_id) {
        await atualizarEstoqueShopify(token, existente.inventory_item_id, Math.floor(produtoHiper.quantidadeEmEstoque || 0))
          .catch(err => console.warn(`⚠️ Erro ao atualizar estoque da variante ${existente.id}: ${err.message}`));
      } else {
        console.warn(`⚠️ Variante ${existente.id} não tem inventory_item_id. Estoque não atualizado.`);
      }
    } else {
      variant.inventory_quantity = Math.floor(produtoHiper.quantidadeEmEstoque || 0);
    }
    variantsAtualizados.push(variant);
  }

  // Monta a atualização SEM o campo "options"
  const atualizacao = {
    product: {
      id: produtoExistente.id,
      title: produtoHiper.nome,
      body_html: produtoHiper.descricao || '',
      vendor: produtoHiper.marca || '',
      product_type: produtoHiper.categoria || '',
      status: produtoHiper.ativo ? 'active' : 'draft',
      variants: variantsAtualizados
      // options NÃO É ENVIADO
    }
  };

  const opcoes = {
    hostname: `${CONFIG.shopify.loja}.myshopify.com`,
    path: `/admin/api/2026-07/products/${produtoExistente.id}.json`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    }
  };

  try {
    const res = await request(opcoes, JSON.stringify(atualizacao));
    if (res.errors) {
      console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${JSON.stringify(res.errors)}`);
      return null;
    }
    console.log(`✅ Produto "${produtoHiper.nome}" ATUALIZADO (preço e opções) na Shopify!`);
    return res.product;
  } catch (erro) {
    console.error(`❌ Erro ao atualizar "${produtoHiper.nome}": ${erro.message}`);
    return null;
  }
}

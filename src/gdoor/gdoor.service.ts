import { Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { PlanosService } from '../planos/planos.service';

const normalizarCnpj = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

const CATEGORIA_PADRAO_IMPORTACAO = 'Importado do GDOOR';

// Tolerância de 1 centavo pra não marcar como "divergente" arredondamento de ponto flutuante.
const precoDiverge = (a: number | null, b: number | null) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) > 0.01;
};
const qtdDiverge = (a: number | null, b: number | null) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) > 0.001;
};
const nomeDiverge = (a: string | null, b: string | null) => {
  if (!a || !b) return false;
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
};

@Injectable()
export class GdoorService {
  constructor(private supabase: SupabaseService, private planos: PlanosService) {}

  // ── Lado dono (RestaurantOwnerGuard) ──────────────────────────────

  async gerarToken(restaurantId: number) {
    const token = crypto.randomUUID();
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_agente_token: token })
      .eq('id', restaurantId);
    if (error) throw error;
    return { token };
  }

  async statusAgente(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('gdoor_agente_token, gdoor_agente_ultimo_ping, gdoor_cnpj_esperado, gdoor_cnpj_confirmado')
      .eq('id', restaurantId)
      .maybeSingle();

    const ultimoPing = data?.gdoor_agente_ultimo_ping ? new Date(data.gdoor_agente_ultimo_ping) : null;
    const online = !!ultimoPing && Date.now() - ultimoPing.getTime() < 60_000;
    const cnpjEsperado = data?.gdoor_cnpj_esperado ?? null;
    const cnpjConfirmado = data?.gdoor_cnpj_confirmado ?? null;
    // Sem CNPJ esperado cadastrado ainda = não dá pra afirmar que confere nem que não confere.
    const cnpjConfere = cnpjEsperado && cnpjConfirmado
      ? normalizarCnpj(cnpjEsperado) === normalizarCnpj(cnpjConfirmado)
      : null;

    return {
      pareado: !!data?.gdoor_agente_token,
      online,
      ultimo_ping: data?.gdoor_agente_ultimo_ping ?? null,
      cnpj_esperado: cnpjEsperado,
      cnpj_confirmado: cnpjConfirmado,
      cnpj_confere: cnpjConfere,
    };
  }

  async salvarCnpjEsperado(restaurantId: number, cnpj: string) {
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_cnpj_esperado: cnpj?.trim() || null })
      .eq('id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // ── Lado agente (AgenteGdoorGuard) ────────────────────────────────

  // Chamado pelo agente Python a cada poll — mantém gdoor_cnpj_confirmado sempre
  // atualizado com o que o Firebird local reportou de verdade, pra comparação.
  async registrarCnpjAgente(restaurantId: number, cnpj: string) {
    if (!cnpj?.trim()) return { ok: true };
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_cnpj_confirmado: cnpj.trim() })
      .eq('id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // INSERT puro — nunca faz chamada HTTP. O agente é quem puxa (polling), nunca
  // o contrário (server_delivery roda na nuvem, não alcança a máquina do restaurante).
  // Resolve product_id -> codigo_gdoor aqui (mapeamento cadastrado no painel) e já
  // grava no payload, pra o agente não precisar de nenhum mapeamento local — só
  // grava o que o job mandar. Item sem mapeamento vai com codigo_gdoor: null, e o
  // agente reporta erro pedindo pra mapear (visível no painel).
  async criarJob(restaurantId: number, pedidoId: number, cliente: any, itens: any[]) {
    const productIds = [...new Set(itens.map((i: any) => i.product_id))];
    const { data: mapeamentos } = await this.supabase.client
      .from('gdoor_produto_mapeamento')
      .select('product_id, codigo_gdoor')
      .eq('restaurant_id', restaurantId)
      .in('product_id', productIds.length ? productIds : [0]);
    const mapa = Object.fromEntries((mapeamentos ?? []).map((m: any) => [m.product_id, m.codigo_gdoor]));

    const itensComCodigo = itens.map((i: any) => ({ ...i, codigo_gdoor: mapa[i.product_id] ?? null }));

    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .insert({ restaurant_id: restaurantId, pedido_id: pedidoId, payload: { cliente, itens: itensComCodigo } });
    if (error) throw error;
    return { ok: true };
  }

  // ── Catálogo/mapeamento de produtos (lado dono lê e edita, agente só escreve o cache) ──

  // Upsert (nunca delete+insert total) — precisa preservar bloqueado_sync, que
  // é decisão do dono e não pode ser resetada a cada report do agente. Só
  // remove do cache os códigos que sumiram de verdade do relatório (item
  // excluído/renomeado no GDOOR).
  async registrarEstoque(restaurantId: number, itens: { codigo: string; descricao?: string; preco_venda?: number; qtd?: number; unidade?: string }[]) {
    if (itens.length > 0) {
      const linhas = itens.map((i) => ({
        restaurant_id: restaurantId,
        codigo: i.codigo,
        descricao: i.descricao ?? null,
        preco_venda: i.preco_venda ?? null,
        qtd: i.qtd ?? null,
        unidade: i.unidade ?? null,
        atualizado_em: new Date().toISOString(),
      }));
      const { error } = await this.supabase.client
        .from('gdoor_estoque_cache')
        .upsert(linhas, { onConflict: 'restaurant_id,codigo' });
      if (error) throw error;

      const codigosAtuais = itens.map((i) => i.codigo);
      await this.supabase.client
        .from('gdoor_estoque_cache')
        .delete()
        .eq('restaurant_id', restaurantId)
        .not('codigo', 'in', `(${codigosAtuais.map((c) => `"${c}"`).join(',')})`);
    } else {
      await this.supabase.client.from('gdoor_estoque_cache').delete().eq('restaurant_id', restaurantId);
    }
    return { ok: true };
  }

  async bloquearSync(restaurantId: number, codigo: string, bloqueado: boolean) {
    const { error } = await this.supabase.client
      .from('gdoor_estoque_cache')
      .update({ bloqueado_sync: bloqueado })
      .eq('restaurant_id', restaurantId)
      .eq('codigo', codigo);
    if (error) throw error;
    return { ok: true };
  }

  // Catálogo dos dois lados de uma vez, já com status de mapeamento e
  // divergência (nome/preço/qtd) — alimenta o modal de mapeamento no painel.
  async catalogoCompleto(restaurantId: number) {
    const [{ data: produtos, error: errProdutos }, { data: estoque, error: errEstoque }, { data: mapeamentos, error: errMapa }] = await Promise.all([
      this.supabase.client
        .from('products')
        .select('id, name, price, quantidade_estoque, category_id, is_active, categories(name)')
        .eq('restaurant_id', restaurantId)
        .order('name'),
      this.supabase.client
        .from('gdoor_estoque_cache')
        .select('codigo, descricao, preco_venda, qtd, unidade, bloqueado_sync')
        .eq('restaurant_id', restaurantId)
        .order('descricao'),
      this.supabase.client
        .from('gdoor_produto_mapeamento')
        .select('product_id, codigo_gdoor, descricao_gdoor')
        .eq('restaurant_id', restaurantId),
    ]);
    if (errProdutos) throw errProdutos;
    if (errEstoque) throw errEstoque;
    if (errMapa) throw errMapa;

    const mapaPorProduto = Object.fromEntries((mapeamentos ?? []).map((m: any) => [m.product_id, m]));
    const mapaPorCodigo = Object.fromEntries((mapeamentos ?? []).map((m: any) => [m.codigo_gdoor, m]));
    const estoquePorCodigo = Object.fromEntries((estoque ?? []).map((e: any) => [e.codigo, e]));

    const produtosDelivery = (produtos ?? []).map((p: any) => {
      const mapa = mapaPorProduto[p.id];
      const itemGdoor = mapa ? estoquePorCodigo[mapa.codigo_gdoor] : null;
      const diverge = !!itemGdoor && (
        nomeDiverge(p.name, itemGdoor.descricao) ||
        precoDiverge(p.price, itemGdoor.preco_venda) ||
        qtdDiverge(p.quantidade_estoque, itemGdoor.qtd)
      );
      return {
        id: p.id,
        name: p.name,
        price: p.price,
        quantidade_estoque: p.quantidade_estoque,
        category_name: p.categories?.name ?? 'Outros',
        is_active: p.is_active,
        codigo_gdoor: mapa?.codigo_gdoor ?? null,
        diverge,
      };
    });

    const estoqueGdoor = (estoque ?? []).map((e: any) => {
      const mapa = mapaPorCodigo[e.codigo];
      const produto = mapa ? (produtos ?? []).find((p: any) => p.id === mapa.product_id) : null;
      const diverge = !!produto && (
        nomeDiverge(produto.name, e.descricao) ||
        precoDiverge(produto.price, e.preco_venda) ||
        qtdDiverge(produto.quantidade_estoque, e.qtd)
      );
      return {
        codigo: e.codigo,
        descricao: e.descricao,
        preco_venda: e.preco_venda,
        qtd: e.qtd,
        unidade: e.unidade,
        bloqueado_sync: e.bloqueado_sync,
        product_id: mapa?.product_id ?? null,
        nome_delivery: produto?.name ?? null,
        diverge,
      };
    });

    return { produtos_delivery: produtosDelivery, estoque_gdoor: estoqueGdoor };
  }

  // Importa em massa itens do ESTOQUE do GDOOR pro DeliveryHub — cria o produto
  // e já grava o mapeamento na mesma chamada. Ignora item já mapeado ou marcado
  // como "não sincronizar". Mesmo padrão de categoria de RestauranteService.importarProdutos.
  async importarDeGdoor(restaurantId: number, codigos: string[]) {
    const { data: estoque, error: errEstoque } = await this.supabase.client
      .from('gdoor_estoque_cache')
      .select('codigo, descricao, preco_venda, qtd, unidade, bloqueado_sync')
      .eq('restaurant_id', restaurantId)
      .in('codigo', codigos);
    if (errEstoque) throw errEstoque;

    const { data: mapeamentos } = await this.supabase.client
      .from('gdoor_produto_mapeamento')
      .select('codigo_gdoor')
      .eq('restaurant_id', restaurantId)
      .in('codigo_gdoor', codigos);
    const jaMapeados = new Set((mapeamentos ?? []).map((m: any) => m.codigo_gdoor));

    const { data: categoriaPadrao } = await this.supabase.client
      .from('categories')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('name', CATEGORIA_PADRAO_IMPORTACAO)
      .maybeSingle();
    let categoriaId = categoriaPadrao?.id ?? null;

    const importados: string[] = [];
    const ignorados: { codigo: string; motivo: string }[] = [];

    for (const item of estoque ?? []) {
      if (jaMapeados.has(item.codigo)) {
        ignorados.push({ codigo: item.codigo, motivo: 'já mapeado' });
        continue;
      }
      if (item.bloqueado_sync) {
        ignorados.push({ codigo: item.codigo, motivo: 'marcado como não sincronizar' });
        continue;
      }
      if (!item.descricao?.trim()) {
        ignorados.push({ codigo: item.codigo, motivo: 'sem descrição no GDOOR' });
        continue;
      }

      try {
        await this.planos.verificarLimiteProdutos(restaurantId);
      } catch {
        ignorados.push({ codigo: item.codigo, motivo: 'limite de produtos do plano atingido' });
        continue;
      }

      if (categoriaId == null) {
        const { data: novaCategoria, error: errCategoria } = await this.supabase.client
          .from('categories').insert({ name: CATEGORIA_PADRAO_IMPORTACAO, restaurant_id: restaurantId }).select('id').single();
        if (errCategoria) {
          ignorados.push({ codigo: item.codigo, motivo: 'não foi possível criar a categoria' });
          continue;
        }
        categoriaId = novaCategoria.id;
      }

      const { data: novoProduto, error: errProduto } = await this.supabase.client
        .from('products')
        .insert({
          name: item.descricao.trim(),
          price: item.preco_venda ?? 0,
          quantidade_estoque: item.qtd ?? 0,
          category_id: categoriaId,
          restaurant_id: restaurantId,
        })
        .select('id')
        .single();
      if (errProduto) {
        ignorados.push({ codigo: item.codigo, motivo: 'falha ao criar produto' });
        continue;
      }

      await this.supabase.client.from('gdoor_produto_mapeamento').insert({
        restaurant_id: restaurantId,
        product_id: novoProduto.id,
        codigo_gdoor: item.codigo,
        descricao_gdoor: item.descricao,
      });
      importados.push(item.codigo);
    }

    return { importados, ignorados };
  }

  // Enfileira criação de produto no GDOOR — assíncrono (agente puxa via
  // polling), não mapeia ainda: só quando o agente confirmar com o código que
  // o GDOOR local gerou (marcarProdutoCriado).
  async exportarParaGdoor(restaurantId: number, productIds: number[]) {
    const { data: produtos, error: errProdutos } = await this.supabase.client
      .from('products')
      .select('id, name, price, quantidade_estoque')
      .eq('restaurant_id', restaurantId)
      .in('id', productIds);
    if (errProdutos) throw errProdutos;

    const { data: mapeamentos } = await this.supabase.client
      .from('gdoor_produto_mapeamento')
      .select('product_id')
      .eq('restaurant_id', restaurantId)
      .in('product_id', productIds.length ? productIds : [0]);
    const jaMapeados = new Set((mapeamentos ?? []).map((m: any) => m.product_id));

    const enfileirados: number[] = [];
    const ignorados: { product_id: number; motivo: string }[] = [];

    for (const produto of produtos ?? []) {
      if (jaMapeados.has(produto.id)) {
        ignorados.push({ product_id: produto.id, motivo: 'já mapeado' });
        continue;
      }
      const { error } = await this.supabase.client.from('gdoor_criar_produto_jobs').insert({
        restaurant_id: restaurantId,
        product_id: produto.id,
        payload: { descricao: produto.name, preco_venda: produto.price, qtd: produto.quantidade_estoque ?? 0, unidade: 'UN' },
      });
      if (error) {
        ignorados.push({ product_id: produto.id, motivo: 'falha ao enfileirar' });
        continue;
      }
      enfileirados.push(produto.id);
    }

    return { enfileirados, ignorados };
  }

  async statusExportacao(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('gdoor_criar_produto_jobs')
      .select('id, product_id, status, codigo_gdoor_criado, erro_msg, criado_em, processado_em')
      .eq('restaurant_id', restaurantId)
      .order('criado_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    return { jobs: data ?? [] };
  }

  async salvarMapeamentoProduto(restaurantId: number, productId: number, codigoGdoor: string | null, descricaoGdoor?: string) {
    if (!codigoGdoor?.trim()) {
      const { error } = await this.supabase.client
        .from('gdoor_produto_mapeamento')
        .delete()
        .eq('restaurant_id', restaurantId)
        .eq('product_id', productId);
      if (error) throw error;
      return { ok: true };
    }

    const { error } = await this.supabase.client
      .from('gdoor_produto_mapeamento')
      .upsert(
        { restaurant_id: restaurantId, product_id: productId, codigo_gdoor: codigoGdoor.trim(), descricao_gdoor: descricaoGdoor ?? null, atualizado_em: new Date().toISOString() },
        { onConflict: 'restaurant_id,product_id' },
      );
    if (error) throw error;
    return { ok: true };
  }

  // Só devolve trabalho se o CNPJ confirmado bater com o esperado — trava de
  // segurança extra além do token: mesmo com o token certo, um GDOOR de outro
  // CNPJ (instalação errada) não recebe pré-vendas.
  async jobsPendentes(restaurantId: number, cnpjEsperado: string | null, cnpjConfirmado: string | null) {
    const cnpjConfere = !cnpjEsperado || (cnpjConfirmado && normalizarCnpj(cnpjEsperado) === normalizarCnpj(cnpjConfirmado));
    if (!cnpjConfere) return { jobs: [], bloqueado: true };

    const { data, error } = await this.supabase.client
      .from('gdoor_jobs')
      .select('id, pedido_id, payload')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .order('criado_em', { ascending: true });
    if (error) throw error;
    return { jobs: data ?? [], bloqueado: false };
  }

  private async garantirJobDoRestaurante(jobId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('gdoor_jobs')
      .select('id')
      .eq('id', jobId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Trabalho não encontrado');
  }

  async marcarProcessado(jobId: number, restaurantId: number, vendaIdGdoor: string) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .update({ status: 'processado', venda_id_gdoor: vendaIdGdoor, processado_em: new Date().toISOString() })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }

  async marcarErro(jobId: number, restaurantId: number, mensagem: string) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .update({ status: 'erro', erro_msg: mensagem ?? 'Erro desconhecido' })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }

  // ── Criação de produto no GDOOR (Delivery -> GDOOR, fila separada) ────

  async criarProdutoPendentes(restaurantId: number, cnpjEsperado: string | null, cnpjConfirmado: string | null) {
    const cnpjConfere = !cnpjEsperado || (cnpjConfirmado && normalizarCnpj(cnpjEsperado) === normalizarCnpj(cnpjConfirmado));
    if (!cnpjConfere) return { jobs: [], bloqueado: true };

    const { data, error } = await this.supabase.client
      .from('gdoor_criar_produto_jobs')
      .select('id, payload')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .order('criado_em', { ascending: true });
    if (error) throw error;
    return { jobs: data ?? [], bloqueado: false };
  }

  private async garantirJobCriarProdutoDoRestaurante(jobId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('gdoor_criar_produto_jobs')
      .select('id, product_id')
      .eq('id', jobId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Trabalho não encontrado');
    return data;
  }

  // Marca o job concluído e já grava o mapeamento com o código que o GDOOR
  // local gerou — é o "mapear automático com o referencial" que fecha o
  // ciclo de exportação sem passo manual extra.
  async marcarProdutoCriado(jobId: number, restaurantId: number, codigoGdoor: string) {
    const job = await this.garantirJobCriarProdutoDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_criar_produto_jobs')
      .update({ status: 'processado', codigo_gdoor_criado: codigoGdoor, processado_em: new Date().toISOString() })
      .eq('id', jobId);
    if (error) throw error;

    await this.supabase.client.from('gdoor_produto_mapeamento').upsert(
      { restaurant_id: restaurantId, product_id: job.product_id, codigo_gdoor: codigoGdoor, atualizado_em: new Date().toISOString() },
      { onConflict: 'restaurant_id,product_id' },
    );
    return { ok: true };
  }

  async marcarProdutoErro(jobId: number, restaurantId: number, mensagem: string) {
    await this.garantirJobCriarProdutoDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_criar_produto_jobs')
      .update({ status: 'erro', erro_msg: mensagem ?? 'Erro desconhecido' })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }
}

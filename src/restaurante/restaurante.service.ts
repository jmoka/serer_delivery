import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CategoriasService } from '../categorias/categorias.service';
import { ProdutosService } from '../produtos/produtos.service';
import { PedidosService } from '../pedidos/pedidos.service';
import { GeocodingService } from '../motoboy/geocoding.service';
import { MotoboyService } from '../motoboy/motoboy.service';

@Injectable()
export class RestauranteService {
  constructor(
    private supabase: SupabaseService,
    private categorias: CategoriasService,
    private produtos: ProdutosService,
    private pedidos: PedidosService,
    private geocoding: GeocodingService,
    private motoboyService: MotoboyService,
  ) {}

  async minhaEmpresa(userId: string) {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .select('id, name, address, state, city, neighborhood, cep, logo_url, slug, business_hours, payment_config, comissao_pct, type_id, created_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException('Nenhum restaurante vinculado');

    const { data: tipoRestaurante } = await this.supabase.client
      .from('establishment_types')
      .select('id')
      .eq('name', 'Restaurante')
      .maybeSingle();

    const { data: pedidosData } = await this.supabase.client
      .from('orders')
      .select('id, total, status')
      .eq('restaurant_id', data.id);

    const entregues = (pedidosData ?? []).filter((p) => p.status === 'delivered');
    const pendentes = (pedidosData ?? []).filter((p) =>
      ['pending', 'confirmed', 'ready', 'out_for_delivery'].includes(p.status),
    );
    const faturamento = entregues.reduce((acc, p) => acc + (p.total ?? 0), 0);

    return {
      empresa: { ...data, tipo_restaurante: data.type_id === tipoRestaurante?.id },
      metricas: {
        total_pedidos: pedidosData?.length ?? 0,
        pedidos_pendentes: pendentes.length,
        pedidos_entregues: entregues.length,
        faturamento,
      },
    };
  }

  async meusPedidos(restaurantId: number, filtros: { status?: string; limite?: number }) {
    return this.pedidos.listar({
      empresa_id: restaurantId,
      status: filtros.status,
      limite: filtros.limite ?? 50,
    });
  }

  async cancelarPedidoAdmin(restaurantId: number, pedidoId: number, motivo: string) {
    if (!motivo?.trim()) throw new BadRequestException('Motivo do cancelamento é obrigatório');

    const { data: pedido, error } = await this.supabase.client
      .from('orders')
      .select('id, status')
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (error) throw error;
    if (!pedido) throw new NotFoundException('Pedido não encontrado neste restaurante');
    if (pedido.status === 'canceled') throw new BadRequestException('Pedido já está cancelado');

    const { data, error: errUpd } = await this.supabase.client
      .from('orders')
      .update({ status: 'canceled', cancel_reason: motivo.trim(), updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .select('id, status, cancel_reason, total, updated_at')
      .single();

    if (errUpd) throw errUpd;
    return data;
  }

  async atualizarStatusPedido(pedidoId: number, restaurantId: number, status: string) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id')
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (!pedido) throw new NotFoundException('Pedido não encontrado neste restaurante');

    return this.pedidos.atualizarStatus(pedidoId, status as any);
  }

  // Painel de controle de entregas: tudo que está "em voo" agora (pronto aguardando
  // atribuição, indo buscar, ou já saiu pra entrega), com dados de quem está entregando.
  async listarEntregas(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select(
        'id, status, total, payment_method, motoboy_id, entrega_propria, motoboy_lat, motoboy_lng, motoboy_location_at, created_at, updated_at, customer_id',
      )
      .eq('restaurant_id', restaurantId)
      .in('status', ['ready', 'motoboy_collecting', 'out_for_delivery'])
      .order('created_at', { ascending: true });
    if (error) throw error;

    const motoboyIds = [...new Set((data ?? []).map((o) => o.motoboy_id).filter(Boolean))];
    const customerIds = [...new Set((data ?? []).map((o) => o.customer_id).filter(Boolean))];

    const [{ data: motoboys }, { data: customers }] = await Promise.all([
      motoboyIds.length
        ? this.supabase.client.from('motoboys').select('id, name, phone').in('id', motoboyIds)
        : Promise.resolve({ data: [] as any[] }),
      customerIds.length
        ? this.supabase.client.from('customers').select('id, name, address_json').in('id', customerIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const motoboyMap = Object.fromEntries((motoboys ?? []).map((m: any) => [m.id, m]));
    const customerMap = Object.fromEntries((customers ?? []).map((c: any) => [c.id, c]));

    const entregas = (data ?? []).map((o) => ({
      ...o,
      motoboy: o.motoboy_id ? motoboyMap[o.motoboy_id] ?? null : null,
      cliente: o.customer_id ? customerMap[o.customer_id] ?? null : null,
    }));
    return { entregas };
  }

  async entregarPedidoProprio(
    pedidoId: number,
    restaurantId: number,
    entregaPagamento?: { metodo: string; dinheiro?: number; pix?: number },
  ) {
    return this.motoboyService.entregarProprio(pedidoId, restaurantId, entregaPagamento);
  }

  private async catIdsDoRestaurante(restaurantId: number): Promise<number[]> {
    const { data } = await this.supabase.client
      .from('categories')
      .select('id')
      .or(`restaurant_id.eq.${restaurantId},restaurant_id.is.null`);
    return (data ?? []).map((c: any) => c.id);
  }

  private async verificarProdutoDoRestaurante(produtoId: number, restaurantId: number) {
    const { data: prod } = await this.supabase.client
      .from('products').select('id, category_id, restaurant_id').eq('id', produtoId).maybeSingle();
    if (!prod) throw new NotFoundException('Produto não encontrado');
    if (prod.restaurant_id !== restaurantId) throw new NotFoundException('Produto não pertence a este restaurante');
    return prod;
  }

  async meusProdutos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, name, description, price, preco_promo, image_url, is_active, category_id, restaurant_id, tags, destaque, impressora_id, created_at, categories(name)')
      .eq('restaurant_id', restaurantId)
      .order('destaque', { ascending: false })
      .order('name');

    if (error) throw error;
    // category_name direto no produto (igual ao endpoint do garçom) pra telas com
    // filtro por categoria não precisarem buscar/montar o map à parte.
    const produtos = (data ?? []).map((p: any) => ({ ...p, category_name: p.categories?.name ?? 'Outros' }));
    return { produtos };
  }

  async criarProduto(
    restaurantId: number,
    body: {
      name: string; description?: string; price: number; image_url?: string;
      category_id: number; tags?: string[]; preco_promo?: number; destaque?: boolean;
      impressora_id?: number;
    },
  ) {
    // Valida se a categoria é do restaurante ou global (restaurant_id IS NULL)
    const { data: cat } = await this.supabase.client
      .from('categories').select('id, restaurant_id').eq('id', body.category_id).maybeSingle();
    if (!cat) throw new NotFoundException('Categoria não encontrada');
    if (cat.restaurant_id !== null && cat.restaurant_id !== restaurantId)
      throw new NotFoundException('Categoria não pertence a este restaurante');

    const { data, error } = await this.supabase.client
      .from('products')
      .insert({
        name: body.name,
        description: body.description ?? null,
        price: body.price,
        preco_promo: body.preco_promo ?? null,
        image_url: body.image_url ?? null,
        category_id: body.category_id,
        restaurant_id: restaurantId,
        tags: body.tags ?? [],
        destaque: body.destaque ?? false,
        impressora_id: body.impressora_id ?? null,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async editarProduto(produtoId: number, restaurantId: number, body: any) {
    await this.verificarProdutoDoRestaurante(produtoId, restaurantId);

    const update: any = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description ?? null;
    if (body.price !== undefined) update.price = body.price;
    if (body.preco_promo !== undefined) update.preco_promo = body.preco_promo ?? null;
    if (body.image_url !== undefined) update.image_url = body.image_url ?? null;
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.destaque !== undefined) update.destaque = body.destaque;
    if (body.impressora_id !== undefined) update.impressora_id = body.impressora_id ?? null;
    if (body.category_id !== undefined) {
      const { data: cat } = await this.supabase.client
        .from('categories').select('id, restaurant_id').eq('id', body.category_id).maybeSingle();
      if (!cat) throw new NotFoundException('Categoria não encontrada');
      if (cat.restaurant_id !== null && cat.restaurant_id !== restaurantId)
        throw new NotFoundException('Categoria não pertence a este restaurante');
      update.category_id = body.category_id;
    }

    const { data, error } = await this.supabase.client
      .from('products').update(update).eq('id', produtoId).select().single();
    if (error) throw error;
    return data;
  }

  async deletarProduto(produtoId: number, restaurantId: number) {
    await this.verificarProdutoDoRestaurante(produtoId, restaurantId);
    const { error } = await this.supabase.client.from('products').delete().eq('id', produtoId);
    if (error) throw error;
    return { ok: true };
  }

  async toggleProduto(produtoId: number, restaurantId: number, ativo: boolean) {
    await this.verificarProdutoDoRestaurante(produtoId, restaurantId);
    return this.produtos.toggleAtivo(produtoId, ativo);
  }

  // ── Combos ──────────────────────────────────────────────────────────────────

  async meusCombos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('combos')
      .select('id, name, description, price, preco_promo, image_url, is_active, destaque, created_at')
      .eq('restaurant_id', restaurantId)
      .order('destaque', { ascending: false })
      .order('name');
    if (error) throw error;
    return { combos: data ?? [] };
  }

  async getComboDetalhe(comboId: number, restaurantId: number) {
    const { data: combo } = await this.supabase.client
      .from('combos').select('*').eq('id', comboId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!combo) throw new NotFoundException('Combo não encontrado');

    const { data: items } = await this.supabase.client
      .from('combo_items')
      .select('id, quantity, product_id, products(id, name, price, image_url)')
      .eq('combo_id', comboId);

    return { ...combo, items: items ?? [] };
  }

  async criarCombo(restaurantId: number, body: {
    name: string; description?: string; price: number; preco_promo?: number;
    image_url?: string; destaque?: boolean; items?: { product_id: number; quantity: number }[];
  }) {
    const { data: combo, error } = await this.supabase.client
      .from('combos')
      .insert({
        restaurant_id: restaurantId,
        name: body.name,
        description: body.description ?? null,
        price: body.price,
        preco_promo: body.preco_promo ?? null,
        image_url: body.image_url ?? null,
        destaque: body.destaque ?? false,
        is_active: true,
      })
      .select()
      .single();
    if (error) throw error;

    if (body.items?.length) {
      await this.supabase.client.from('combo_items').insert(
        body.items.map((i) => ({ combo_id: combo.id, product_id: i.product_id, quantity: i.quantity })),
      );
    }

    return this.getComboDetalhe(combo.id, restaurantId);
  }

  async editarCombo(comboId: number, restaurantId: number, body: any) {
    const { data: existing } = await this.supabase.client
      .from('combos').select('id').eq('id', comboId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!existing) throw new NotFoundException('Combo não encontrado');

    const update: any = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description ?? null;
    if (body.price !== undefined) update.price = body.price;
    if (body.preco_promo !== undefined) update.preco_promo = body.preco_promo ?? null;
    if (body.image_url !== undefined) update.image_url = body.image_url ?? null;
    if (body.destaque !== undefined) update.destaque = body.destaque;
    if (body.is_active !== undefined) update.is_active = body.is_active;

    if (Object.keys(update).length > 0) {
      const { error } = await this.supabase.client.from('combos').update(update).eq('id', comboId);
      if (error) throw error;
    }

    if (Array.isArray(body.items)) {
      await this.supabase.client.from('combo_items').delete().eq('combo_id', comboId);
      if (body.items.length > 0) {
        await this.supabase.client.from('combo_items').insert(
          body.items.map((i: any) => ({ combo_id: comboId, product_id: i.product_id, quantity: i.quantity })),
        );
      }
    }

    return this.getComboDetalhe(comboId, restaurantId);
  }

  async deletarCombo(comboId: number, restaurantId: number) {
    const { data: existing } = await this.supabase.client
      .from('combos').select('id').eq('id', comboId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!existing) throw new NotFoundException('Combo não encontrado');
    const { error } = await this.supabase.client.from('combos').delete().eq('id', comboId);
    if (error) throw error;
    return { ok: true };
  }

  async minhasCategorias(restaurantId: number) {
    return this.categorias.listarPorEmpresa(restaurantId);
  }

  async criarCategoria(restaurantId: number, body: { name: string }) {
    return this.categorias.criar({ name: body.name, restaurant_id: restaurantId });
  }

  async deletarCategoria(categoriaId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('categories').select('id').eq('id', categoriaId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!data) throw new NotFoundException('Categoria não encontrada neste restaurante');
    return this.categorias.remover(categoriaId);
  }

  async listarClientes(restaurantId: number, filtros: { busca?: string; limite?: number }) {
    // Busca IDs dos clientes vinculados a este restaurante
    const { data: crRows, error: crErr } = await this.supabase.client
      .from('customer_restaurants')
      .select('customer_id')
      .eq('restaurant_id', restaurantId);

    if (crErr) throw crErr;
    const customerIds = (crRows ?? []).map((r) => r.customer_id);
    if (customerIds.length === 0) return { clientes: [], total: 0 };

    // Busca dados dos clientes com filtro opcional
    let q = this.supabase.client
      .from('customers')
      .select('id, name, email, phone_e164, notes, user_id, created_at')
      .in('id', customerIds)
      .order('name');

    if (filtros.busca) {
      q = q.or(`name.ilike.%${filtros.busca}%,email.ilike.%${filtros.busca}%,phone_e164.ilike.%${filtros.busca}%`);
    }
    if (filtros.limite) q = q.limit(filtros.limite);

    const { data: clientes, error: cErr } = await q;
    if (cErr) throw cErr;

    if (!clientes?.length) return { clientes: [], total: 0 };

    // Busca estatísticas de pedidos por cliente neste restaurante
    const ids = clientes.map((c) => c.id);
    const { data: pedidos } = await this.supabase.client
      .from('orders')
      .select('customer_id, total, created_at')
      .eq('restaurant_id', restaurantId)
      .in('customer_id', ids)
      .neq('status', 'canceled');

    const statsMap: Record<number, { count: number; total: number; ultimo: string | null }> = {};
    for (const p of pedidos ?? []) {
      if (!statsMap[p.customer_id]) statsMap[p.customer_id] = { count: 0, total: 0, ultimo: null };
      statsMap[p.customer_id].count++;
      statsMap[p.customer_id].total += parseFloat(p.total);
      if (!statsMap[p.customer_id].ultimo || p.created_at > (statsMap[p.customer_id].ultimo as string)) {
        statsMap[p.customer_id].ultimo = p.created_at;
      }
    }

    const result = clientes.map((c) => ({
      ...c,
      pedidos_count: statsMap[c.id]?.count ?? 0,
      total_gasto: statsMap[c.id]?.total ?? 0,
      ultimo_pedido: statsMap[c.id]?.ultimo ?? null,
    }));

    return { clientes: result, total: result.length };
  }

  async criarCliente(
    restaurantId: number,
    body: { name: string; email?: string; phone_e164?: string; notes?: string },
  ) {
    const { data, error } = await this.supabase.client
      .from('customers')
      .insert({
        name: body.name,
        email: body.email ?? null,
        phone_e164: body.phone_e164 ?? null,
        notes: body.notes ?? null,
      })
      .select()
      .single();

    if (error) throw error;

    // Vincula ao restaurante
    await this.supabase.client
      .from('customer_restaurants')
      .insert({ customer_id: data.id, restaurant_id: restaurantId })
      .throwOnError();

    return data;
  }

  async atualizarCliente(
    clienteId: number,
    restaurantId: number,
    body: Partial<{ name: string; email: string; phone_e164: string; notes: string }>,
  ) {
    // Verifica vínculo com o restaurante
    const { data: cr } = await this.supabase.client
      .from('customer_restaurants')
      .select('customer_id')
      .eq('customer_id', clienteId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (!cr) throw new NotFoundException('Cliente não encontrado neste restaurante');

    const { data, error } = await this.supabase.client
      .from('customers')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', clienteId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateEmpresa(
    restaurantId: number,
    body: { name?: string; address?: string; state?: string; city?: string; neighborhood?: string; cep?: string; logo_url?: string },
  ) {
    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) campos.name = body.name;
    if (body.address !== undefined) campos.address = body.address;
    if (body.state !== undefined) campos.state = body.state;
    if (body.city !== undefined) campos.city = body.city;
    if (body.neighborhood !== undefined) campos.neighborhood = body.neighborhood;
    if (body.cep !== undefined) campos.cep = body.cep ? body.cep.replace(/\D/g, '') : null;
    if (body.logo_url !== undefined) campos.logo_url = body.logo_url;

    const { data, error } = await this.supabase.client
      .from('restaurants')
      .update(campos)
      .eq('id', restaurantId)
      .select('id, name, address, state, city, neighborhood, cep, logo_url, slug')
      .maybeSingle();

    if (error) throw error;

    // Geocodifica o endereço em background (best-effort) pro cálculo de comissão por km —
    // nunca falha a request de salvar o endereço por causa disso.
    if (body.address !== undefined) {
      this.geocodificarEndereco(restaurantId, body.address).catch(() => {});
    }

    return data;
  }

  private async geocodificarEndereco(restaurantId: number, endereco: string) {
    const coords = await this.geocoding.geocodeEndereco(endereco);
    await this.supabase.client
      .from('restaurants')
      .update({
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        geocoded_at: new Date().toISOString(),
        geocode_falhou: !coords,
      })
      .eq('id', restaurantId);
  }

  async getAparencia(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('aparencia')
      .eq('id', restaurantId)
      .maybeSingle();
    return (data?.aparencia ?? {}) as Record<string, any>;
  }

  async updateAparencia(restaurantId: number, body: Record<string, any>) {
    const { data: atual } = await this.supabase.client
      .from('restaurants')
      .select('aparencia')
      .eq('id', restaurantId)
      .maybeSingle();

    const nova = { ...(atual?.aparencia ?? {}), ...body };

    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ aparencia: nova, updated_at: new Date().toISOString() })
      .eq('id', restaurantId);

    if (error) throw error;
    return nova;
  }

  async getConfig(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select(
        'payment_config, frete_motoboy, usa_motoboy, motoboy_comissao_tipo, motoboy_comissao_valor_fixo, motoboy_comissao_percentual, motoboy_comissao_valor_km, motoboy_comissao_km_fallback, geocode_falhou, gorjeta_percentual, salao_modo, recibo_impressora_id',
      )
      .eq('id', restaurantId)
      .maybeSingle();

    const cfg = (data?.payment_config ?? {}) as Record<string, any>;

    return {
      pagbank_sandbox: cfg.pagbank_sandbox ?? true,
      pagbank_webhook_url: cfg.pagbank_webhook_url ?? '',
      pagbank_token_masked: cfg.pagbank_token
        ? `${'•'.repeat(8)}${String(cfg.pagbank_token).slice(-4)}`
        : null,
      pagbank_seller_account_id: cfg.pagbank_seller_account_id ?? '',
      configurado: !!cfg.pagbank_token,
      split_ativo: !!(cfg.pagbank_seller_account_id),
      taxa_pagbank_percent: cfg.taxa_pagbank_percent ?? null,
      chave_pix: cfg.chave_pix ?? null,
      frete_motoboy: parseFloat(data?.frete_motoboy ?? 0),
      usa_motoboy: data?.usa_motoboy ?? true,
      motoboy_comissao_tipo: data?.motoboy_comissao_tipo ?? 'fixo',
      motoboy_comissao_valor_fixo: parseFloat(data?.motoboy_comissao_valor_fixo ?? 0),
      motoboy_comissao_percentual: parseFloat(data?.motoboy_comissao_percentual ?? 0),
      motoboy_comissao_valor_km: parseFloat(data?.motoboy_comissao_valor_km ?? 0),
      motoboy_comissao_km_fallback: parseFloat(data?.motoboy_comissao_km_fallback ?? 0),
      geocode_falhou: !!data?.geocode_falhou,
      gorjeta_percentual: parseFloat(data?.gorjeta_percentual ?? 0),
      salao_modo: data?.salao_modo ?? 'ambos',
      recibo_impressora_id: data?.recibo_impressora_id ?? null,
    };
  }

  async updateConfig(
    restaurantId: number,
    body: {
      pagbank_token?: string;
      pagbank_sandbox?: boolean;
      pagbank_webhook_url?: string;
      pagbank_seller_account_id?: string;
      taxa_pagbank_percent?: number | null;
      chave_pix?: string | null;
      frete_motoboy?: number;
      usa_motoboy?: boolean;
      motoboy_comissao_tipo?: 'fixo' | 'percentual' | 'km';
      motoboy_comissao_valor_fixo?: number;
      motoboy_comissao_percentual?: number;
      motoboy_comissao_valor_km?: number;
      motoboy_comissao_km_fallback?: number;
      gorjeta_percentual?: number;
      salao_modo?: 'mesas' | 'comandas' | 'ambos';
      recibo_impressora_id?: number | null;
    },
  ) {
    const { data: atual } = await this.supabase.client
      .from('restaurants')
      .select('payment_config')
      .eq('id', restaurantId)
      .maybeSingle();

    const cfg = (atual?.payment_config ?? {}) as Record<string, any>;

    const novo: Record<string, any> = { ...cfg };
    if (body.pagbank_token !== undefined && body.pagbank_token !== '') {
      novo.pagbank_token = body.pagbank_token;
    }
    if (body.pagbank_sandbox !== undefined) novo.pagbank_sandbox = body.pagbank_sandbox;
    if (body.pagbank_webhook_url !== undefined) novo.pagbank_webhook_url = body.pagbank_webhook_url;
    if (body.pagbank_seller_account_id !== undefined) novo.pagbank_seller_account_id = body.pagbank_seller_account_id;
    if (body.taxa_pagbank_percent !== undefined) novo.taxa_pagbank_percent = body.taxa_pagbank_percent;
    if (body.chave_pix !== undefined) novo.chave_pix = body.chave_pix;

    const update: Record<string, any> = { payment_config: novo, updated_at: new Date().toISOString() };
    if (body.frete_motoboy !== undefined) update.frete_motoboy = body.frete_motoboy;
    if (body.usa_motoboy !== undefined) update.usa_motoboy = body.usa_motoboy;
    if (body.motoboy_comissao_tipo !== undefined) update.motoboy_comissao_tipo = body.motoboy_comissao_tipo;
    if (body.motoboy_comissao_valor_fixo !== undefined) update.motoboy_comissao_valor_fixo = body.motoboy_comissao_valor_fixo;
    if (body.motoboy_comissao_percentual !== undefined) update.motoboy_comissao_percentual = body.motoboy_comissao_percentual;
    if (body.motoboy_comissao_valor_km !== undefined) update.motoboy_comissao_valor_km = body.motoboy_comissao_valor_km;
    if (body.motoboy_comissao_km_fallback !== undefined) update.motoboy_comissao_km_fallback = body.motoboy_comissao_km_fallback;
    if (body.gorjeta_percentual !== undefined) update.gorjeta_percentual = body.gorjeta_percentual;
    if (body.salao_modo !== undefined) update.salao_modo = body.salao_modo;
    if (body.recibo_impressora_id !== undefined) update.recibo_impressora_id = body.recibo_impressora_id;

    const { error } = await this.supabase.client
      .from('restaurants')
      .update(update)
      .eq('id', restaurantId);

    if (error) throw error;
    return this.getConfig(restaurantId);
  }

  async toggleStatus(restaurantId: number, aberto: boolean) {
    if (aberto) {
      const { data: caixaAberto } = await this.supabase.client
        .from('caixas').select('id').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();
      if (!caixaAberto) {
        throw new BadRequestException('Abra o caixa antes de abrir o restaurante');
      }
    }
    await this.updateAparencia(restaurantId, { aberto });
    return { aberto };
  }

  async renovarTokenCozinha(restaurantId: number) {
    const novoToken = crypto.randomUUID();
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ cozinha_token: novoToken })
      .eq('id', restaurantId);
    if (error) throw error;
    return { cozinha_token: novoToken };
  }

  async getCozinha(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, payment_method, created_at, customer_id, customers(name, phone_e164)')
      .eq('restaurant_id', restaurantId)
      .in('status', ['confirmed', 'preparing'])
      .order('created_at', { ascending: true });
    if (error) throw error;

    const pedidos = await Promise.all(
      (data ?? []).map(async (o: any) => {
        const { data: itensRaw } = await this.supabase.client
          .from('order_items')
          .select('id, quantity, unit_price, product_id')
          .eq('order_id', o.id);

        let itens: any[] = itensRaw ?? [];
        if (itens.length > 0) {
          const prodIds = itens.map((i) => i.product_id);
          const { data: prods } = await this.supabase.client
            .from('products').select('id, name').in('id', prodIds);
          const prodMap = Object.fromEntries((prods ?? []).map((p: any) => [p.id, p.name]));
          itens = itens.map((i) => ({ ...i, product_name: prodMap[i.product_id] ?? `Produto #${i.product_id}` }));
        }
        return { ...o, itens };
      }),
    );
    return { pedidos };
  }

  // KDS por setor (módulo Salão): tela genérica reaproveitável por impressora/setor
  // (cozinha, bar, salgados...) — lista PLANA de itens (não agrupa por mesa/comanda,
  // cada item tem sua própria ação de preparo/impressão), ordenada por chegada.
  async getKdsSetor(restaurantId: number, impressoraId: number) {
    const { data: itens, error } = await this.supabase.client
      .from('order_items')
      .select('id, quantity, unit_price, observacao, product_id, status, enviado_em, preparando_em, order_id, products(name), orders(id, restaurant_id, mesa_id, cliente_mesa_nome, garcom_id, customer_id, status, motoboy_lat, motoboy_lng, delivery_occurrence, mesas(numero, nome), garcons(nome))')
      .eq('impressora_id', impressoraId)
      .in('status', ['enviado', 'preparando'])
      .order('enviado_em', { ascending: true });
    if (error) throw error;

    const itensValidos = (itens as any[]).filter((i) => i.orders?.restaurant_id === restaurantId);

    // Um item roteado pra uma impressora/setor pode vir tanto de comanda do salão
    // (mesa_id/garcom_id preenchidos) quanto de pedido de delivery (produto com a
    // mesma impressora configurada) — resolve nome do cliente de delivery à parte
    // pra tela poder filtrar e exibir por canal.
    const customerIds = [...new Set(itensValidos.map((i) => i.orders?.customer_id).filter(Boolean))];
    const { data: customers } = customerIds.length
      ? await this.supabase.client.from('customers').select('id, name').in('id', customerIds)
      : { data: [] as any[] };
    const customerMap = Object.fromEntries((customers ?? []).map((c: any) => [c.id, c.name]));

    return {
      itens: itensValidos.map((i) => {
        const ehSalao = !!(i.orders?.mesa_id || i.orders?.garcom_id || i.orders?.cliente_mesa_nome);
        return {
          id: i.id,
          order_id: i.order_id,
          product_name: i.products?.name,
          quantity: i.quantity,
          observacao: i.observacao,
          status: i.status,
          enviado_em: i.enviado_em,
          preparando_em: i.preparando_em,
          tipo: ehSalao ? 'salao' : 'delivery',
          mesa: i.orders?.mesas ? `Mesa ${i.orders.mesas.numero}${i.orders.mesas.nome ? ' - ' + i.orders.mesas.nome : ''}` : null,
          cliente: i.orders?.cliente_mesa_nome ?? (i.orders?.customer_id ? customerMap[i.orders.customer_id] ?? null : null),
          garcom: i.orders?.garcons?.nome ?? null,
          // Status de entrega do pedido (delivery) — usado no Bar pra alerta de motoboy
          // (em trânsito/entregue/ocorrência) e botão de localizar no mapa.
          pedido_status: i.orders?.status ?? null,
          motoboy_lat: i.orders?.motoboy_lat ?? null,
          motoboy_lng: i.orders?.motoboy_lng ?? null,
          delivery_occurrence: i.orders?.delivery_occurrence ?? null,
        };
      }),
    };
  }

  // Move só esse item de "aguardando" (enviado) pra "preparando" — ação por item, não
  // por comanda inteira (cada prato tem seu próprio ritmo de preparo).
  async iniciarPreparoItem(itemId: number, restaurantId: number) {
    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, order_id, orders(restaurant_id)')
      .eq('id', itemId)
      .maybeSingle();
    if (!item || (item as any).orders?.restaurant_id !== restaurantId) {
      throw new NotFoundException('Item não encontrado');
    }

    const { error } = await this.supabase.client
      .from('order_items')
      .update({ status: 'preparando', preparando_em: new Date().toISOString() })
      .eq('id', itemId);
    if (error) throw error;

    return { ok: true };
  }

  async marcarItemPronto(itemId: number, restaurantId: number) {
    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, order_id, orders(restaurant_id)')
      .eq('id', itemId)
      .maybeSingle();

    if (!item || (item as any).orders?.restaurant_id !== restaurantId) {
      throw new NotFoundException('Item não encontrado');
    }

    const { error } = await this.supabase.client.from('order_items').update({ status: 'pronto', pronto_em: new Date().toISOString() }).eq('id', itemId);
    if (error) throw error;
    return { ok: true };
  }

  private readonly STATUS_ABERTOS = ['pending', 'confirmed', 'preparing', 'ready', 'motoboy_collecting', 'out_for_delivery'];
  private readonly COMANDA_STATUS_ABERTOS = ['aberta', 'fechada_garcom'];

  // Venda finalizada = entregue (delivery) ou paga (comanda do salão) — sem isso o
  // resumo/KPI do dashboard ignorava toda venda do salão (comanda nunca vira 'delivered').
  private readonly STATUS_VENDA_FINALIZADA = ['delivered', 'paga'];

  // Comanda do salão pode ter N pagamentos com formas diferentes (parcial pelo garçom +
  // resto pelo caixa) — orders.payment_method só guarda a última forma usada no
  // fechamento, então pra decompor certo o "por forma de pagamento" precisa ir direto
  // no ledger de comanda_pagamentos. Delivery continua com pagamento único (sem mudança).
  private async buscarPagamentosPorComanda(pedidos: any[]): Promise<Map<number, { valor: number; forma_pagamento: string }[]>> {
    const idsComanda = pedidos.filter((p: any) => p.canal === 'presencial').map((p: any) => p.id);
    const mapa = new Map<number, { valor: number; forma_pagamento: string }[]>();
    if (!idsComanda.length) return mapa;

    const { data } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('order_id, valor, forma_pagamento')
      .in('order_id', idsComanda);

    for (const p of (data ?? []) as any[]) {
      if (!mapa.has(p.order_id)) mapa.set(p.order_id, []);
      mapa.get(p.order_id)!.push({ valor: p.valor, forma_pagamento: p.forma_pagamento });
    }
    return mapa;
  }

  private calcularResumo(
    pedidos: any[],
    saidas: any[],
    valor_inicial: number,
    entradas: any[] = [],
    pagamentosPorComanda?: Map<number, { valor: number; forma_pagamento: string }[]>,
  ) {
    const entregues = pedidos.filter((p) => this.STATUS_VENDA_FINALIZADA.includes(p.status));
    const total_vendas = entregues.reduce((s: number, p: any) => s + (p.total ?? 0), 0);
    const total_saidas = saidas.reduce((s: number, e: any) => s + (e.valor ?? 0), 0);
    const total_entradas = entradas.reduce((s: number, e: any) => s + (e.valor ?? 0), 0);

    const por_pagamento: Record<string, number> = {};
    for (const p of entregues) {
      const pagamentosComanda = p.canal === 'presencial' ? pagamentosPorComanda?.get(p.id) : undefined;
      if (pagamentosComanda?.length) {
        for (const pag of pagamentosComanda) {
          const m = pag.forma_pagamento ?? 'outro';
          por_pagamento[m] = (por_pagamento[m] ?? 0) + (pag.valor ?? 0);
        }
      } else {
        const m = p.payment_method ?? 'outro';
        por_pagamento[m] = (por_pagamento[m] ?? 0) + (p.total ?? 0);
      }
    }

    const vendas_dinheiro = por_pagamento['cash'] ?? 0;
    const saidas_especie = saidas
      .filter((s: any) => !s.meio || s.meio === 'dinheiro')
      .reduce((s: number, e: any) => s + (e.valor ?? 0), 0);
    const entradas_especie = entradas
      .filter((e: any) => !e.meio || e.meio === 'dinheiro')
      .reduce((s: number, e: any) => s + (e.valor ?? 0), 0);
    const especie_calculada = valor_inicial + vendas_dinheiro + entradas_especie - saidas_especie;

    return {
      total_pedidos: pedidos.length,
      entregues: entregues.length,
      em_andamento: pedidos.filter((p: any) => this.STATUS_ABERTOS.includes(p.status) || this.COMANDA_STATUS_ABERTOS.includes(p.status)).length,
      cancelados: pedidos.filter((p: any) => p.status === 'canceled').length,
      total_vendas,
      total_saidas,
      total_entradas,
      saldo: valor_inicial + total_vendas + total_entradas - total_saidas,
      por_pagamento,
      especie_calculada,
      saidas_especie,
      entradas_especie,
    };
  }

  async getCaixa(restaurantId: number) {
    const { data: restaurantData } = await this.supabase.client
      .from('restaurants')
      .select('aparencia, saldo_caixa')
      .eq('id', restaurantId)
      .maybeSingle();
    const status_restaurante: boolean = (restaurantData?.aparencia?.aberto) === true;
    const saldo_caixa: number = restaurantData?.saldo_caixa ?? 0;

    // Saldo de caixas fechados que não passaram pelo fluxo de destinação
    // (criados antes da feature — o dinheiro físico ainda existe e deve ser contabilizado)
    const { data: caixasSemDestinacao } = await this.supabase.client
      .from('caixas')
      .select('resumo, destinacao_fechamento')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'fechado')
      .is('destinacao_fechamento', null);

    const saldo_fechados_pendente: number = (caixasSemDestinacao ?? []).reduce((sum: number, c: any) => {
      return sum + (c.resumo?.saldo ?? 0);
    }, 0);

    const { data: caixa } = await this.supabase.client
      .from('caixas')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aberto')
      .maybeSingle();

    if (!caixa) {
      const { data: expirado } = await this.supabase.client
        .from('caixas').select('*').eq('restaurant_id', restaurantId).eq('status', 'expirado').maybeSingle();
      return { status_restaurante, aberto: false, expirado: !!expirado, caixa_expirado: expirado ?? null, pedidos: [], resumo: null, saldo_caixa, saldo_fechados_pendente };
    }

    // Auto-expirar após 8h
    const aberto_em = new Date(caixa.aberto_em);
    const oitoHoras = 8 * 60 * 60 * 1000;
    if (Date.now() - aberto_em.getTime() > oitoHoras) {
      await this.supabase.client.from('caixas').update({ status: 'expirado' }).eq('id', caixa.id);
      return { status_restaurante, aberto: false, expirado: true, caixa_expirado: { ...caixa, status: 'expirado' }, pedidos: [], resumo: null, saldo_caixa, saldo_fechados_pendente };
    }

    const { data: ordersData } = await this.supabase.client
      .from('orders')
      .select('id, total, frete_cobrado, troco_para, status, payment_method, canal, created_at, updated_at, customer_id, motoboy_id, caixa_id, mesa_id, cliente_mesa_nome, numero_comanda, customers(name, phone_e164), motoboys(name), mesas(numero, nome)')
      .eq('restaurant_id', restaurantId)
      .or(`caixa_id.eq.${caixa.id},and(caixa_id.is.null,created_at.gte.${caixa.aberto_em})`)
      .order('created_at', { ascending: false });

    const pedidos = ordersData ?? [];
    const saidas = (caixa.saidas ?? []) as any[];
    const entradas = (caixa.entradas ?? []) as any[];
    const pagamentosPorComanda = await this.buscarPagamentosPorComanda(pedidos);
    const resumo = this.calcularResumo(pedidos, saidas, caixa.valor_inicial, entradas, pagamentosPorComanda);

    return {
      status_restaurante,
      aberto: true,
      expirado: false,
      id: caixa.id,
      nome_operador: caixa.nome_operador,
      aberto_em: caixa.aberto_em,
      valor_inicial: caixa.valor_inicial,
      saidas,
      entradas,
      pedidos,
      resumo,
      saldo_caixa,
      saldo_fechados_pendente,
    };
  }

  async abrirCaixa(restaurantId: number, body: { nome_operador: string; valor_inicial?: number }) {
    if (!body.nome_operador?.trim()) throw new BadRequestException('Nome do operador é obrigatório');

    const { data: existente } = await this.supabase.client
      .from('caixas').select('id, status').eq('restaurant_id', restaurantId)
      .in('status', ['aberto', 'expirado']).maybeSingle();

    if (existente?.status === 'aberto') throw new ConflictException('Já existe um caixa aberto');
    if (existente?.status === 'expirado') throw new ConflictException('Existe um caixa expirado. Feche-o antes de abrir outro');

    // Usar saldo_caixa como valor_inicial padrão se não informado
    const { data: restaurant } = await this.supabase.client
      .from('restaurants').select('saldo_caixa').eq('id', restaurantId).maybeSingle();
    const saldoCaixaAtual = restaurant?.saldo_caixa ?? 0;
    const valorInicial = body.valor_inicial !== undefined ? body.valor_inicial : saldoCaixaAtual;

    const { data: novo, error } = await this.supabase.client
      .from('caixas')
      .insert({ restaurant_id: restaurantId, nome_operador: body.nome_operador.trim(), valor_inicial: valorInicial })
      .select('*')
      .single();

    if (error) throw error;

    // Zerar saldo_caixa — o valor agora está dentro do caixa aberto
    await this.supabase.client.from('restaurants')
      .update({ saldo_caixa: 0 }).eq('id', restaurantId);

    return this.getCaixa(restaurantId);
  }

  async fecharCaixa(restaurantId: number, body?: { dinheiro_contado?: number }) {
    const { data: caixa } = await this.supabase.client
      .from('caixas').select('*').eq('restaurant_id', restaurantId)
      .in('status', ['aberto', 'expirado']).maybeSingle();

    if (!caixa) throw new NotFoundException('Nenhum caixa aberto');

    const { data: pedidosAbertos } = await this.supabase.client
      .from('orders').select('id, status, total')
      .eq('caixa_id', caixa.id)
      .in('status', this.STATUS_ABERTOS);

    const { data: comandasAbertas } = await this.supabase.client
      .from('orders')
      .select('id, status, mesa_id, mesas(numero, nome)')
      .eq('caixa_id', caixa.id)
      .eq('canal', 'presencial')
      .in('status', this.COMANDA_STATUS_ABERTOS);

    const { data: mesasAbertas } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .neq('status', 'livre');

    if ((pedidosAbertos ?? []).length > 0 || (comandasAbertas ?? []).length > 0 || (mesasAbertas ?? []).length > 0) {
      throw new ConflictException({
        message: 'Existem pendências em aberto: feche os pedidos, comandas e mesas antes de fechar o caixa',
        pedidos_abertos: pedidosAbertos?.length ?? 0,
        pedidos: pedidosAbertos ?? [],
        comandas_abertas: comandasAbertas?.length ?? 0,
        comandas: comandasAbertas ?? [],
        mesas_abertas: mesasAbertas?.length ?? 0,
        mesas: mesasAbertas ?? [],
      });
    }

    const { data: todosPedidos } = await this.supabase.client
      .from('orders').select('id, total, status, payment_method, canal, created_at')
      .or(`caixa_id.eq.${caixa.id},and(caixa_id.is.null,created_at.gte.${caixa.aberto_em})`);

    const saidas = (caixa.saidas ?? []) as any[];
    const entradas = (caixa.entradas ?? []) as any[];
    const pagamentosPorComanda = await this.buscarPagamentosPorComanda(todosPedidos ?? []);
    const resumo = this.calcularResumo(todosPedidos ?? [], saidas, caixa.valor_inicial, entradas, pagamentosPorComanda);
    const fechado_em = new Date().toISOString();

    // Conferência: operador informa quanto contou; sistema compara com espécie calculada
    const dinheiro_contado = body?.dinheiro_contado ?? (resumo.especie_calculada ?? 0);
    const diferenca = dinheiro_contado - (resumo.especie_calculada ?? 0);
    const destinacao_fechamento = {
      dinheiro_contado,
      especie_calculada: resumo.especie_calculada,
      diferenca,
      por_pagamento: resumo.por_pagamento,
      conferencia_aprovada: false,
    };

    await this.supabase.client.from('caixas')
      .update({ status: 'fechado', fechado_em, resumo, destinacao_fechamento })
      .eq('id', caixa.id);

    // Sem caixa aberto não há como aceitar pedidos/comandas — fecha o restaurante junto
    await this.updateAparencia(restaurantId, { aberto: false });

    // saldo_caixa = dinheiro contado (o que vai pro cofre para o próximo caixa)
    await this.supabase.client.from('restaurants')
      .update({ saldo_caixa: Math.max(0, dinheiro_contado) }).eq('id', restaurantId);

    return { fechamento: { id: caixa.id, aberto_em: caixa.aberto_em, fechado_em, nome_operador: caixa.nome_operador, valor_inicial: caixa.valor_inicial, saidas, resumo, destinacao_fechamento } };
  }

  async aprovarConferencia(restaurantId: number, caixaId: number) {
    const { data: caixa } = await this.supabase.client
      .from('caixas').select('id, destinacao_fechamento')
      .eq('id', caixaId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!caixa) throw new NotFoundException('Caixa não encontrado');
    const dest = { ...(caixa.destinacao_fechamento ?? {}), conferencia_aprovada: true, aprovado_em: new Date().toISOString() };
    const { error } = await this.supabase.client.from('caixas').update({ destinacao_fechamento: dest }).eq('id', caixaId);
    if (error) throw error;
    return { aprovado: true };
  }

  async fecharComTransferencia(restaurantId: number, body: { nome_operador: string; valor_inicial?: number }) {
    if (!body.nome_operador?.trim()) throw new BadRequestException('Nome do operador do novo caixa é obrigatório');

    const { data: caixa } = await this.supabase.client
      .from('caixas').select('*').eq('restaurant_id', restaurantId)
      .in('status', ['aberto', 'expirado']).maybeSingle();

    if (!caixa) throw new NotFoundException('Nenhum caixa aberto para fechar');

    // Fechar caixa atual (com resumo)
    const { data: todosPedidos } = await this.supabase.client
      .from('orders').select('id, total, status, payment_method, canal, created_at')
      .or(`caixa_id.eq.${caixa.id},and(caixa_id.is.null,created_at.gte.${caixa.aberto_em})`);

    const saidas = (caixa.saidas ?? []) as any[];
    const pagamentosPorComanda = await this.buscarPagamentosPorComanda(todosPedidos ?? []);
    const resumo = this.calcularResumo(todosPedidos ?? [], saidas, caixa.valor_inicial, [], pagamentosPorComanda);
    const fechado_em = new Date().toISOString();
    await this.supabase.client.from('caixas')
      .update({ status: 'fechado', fechado_em, resumo }).eq('id', caixa.id);

    // Abrir novo caixa
    const { data: novoCaixa, error } = await this.supabase.client
      .from('caixas')
      .insert({ restaurant_id: restaurantId, nome_operador: body.nome_operador.trim(), valor_inicial: body.valor_inicial ?? 0 })
      .select('*').single();
    if (error) throw error;

    // Zerar saldo_caixa — novo caixa está aberto, valor físico está dentro dele
    await this.supabase.client.from('restaurants').update({ saldo_caixa: 0 }).eq('id', restaurantId);

    // Transferir pedidos e comandas abertos para o novo caixa (troca de turno não bloqueia, leva o que está em aberto)
    await this.supabase.client
      .from('orders')
      .update({ caixa_id: novoCaixa.id })
      .eq('restaurant_id', restaurantId)
      .in('status', [...this.STATUS_ABERTOS, ...this.COMANDA_STATUS_ABERTOS])
      .eq('caixa_id', caixa.id);

    return {
      fechamento: { id: caixa.id, aberto_em: caixa.aberto_em, fechado_em, nome_operador: caixa.nome_operador, resumo },
      novo_caixa: novoCaixa,
    };
  }

  async getCaixaHistorico(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('caixas')
      .select('id, nome_operador, valor_inicial, status, aberto_em, fechado_em, resumo, destinacao_fechamento')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return { historico: data ?? [] };
  }

  async getCaixaDetalhe(restaurantId: number, caixaId: number) {
    const { data: caixa, error } = await this.supabase.client
      .from('caixas').select('*').eq('id', caixaId).eq('restaurant_id', restaurantId).maybeSingle();
    if (error) throw error;
    if (!caixa) throw new NotFoundException('Caixa não encontrado');

    const { data: pedidos } = await this.supabase.client
      .from('orders')
      .select('id, total, status, payment_method, created_at, customers(name)')
      .or(`caixa_id.eq.${caixa.id},and(caixa_id.is.null,created_at.gte.${caixa.aberto_em})`)
      .order('created_at', { ascending: false });

    return { caixa, pedidos: pedidos ?? [] };
  }

  async adicionarSaida(restaurantId: number, body: { descricao: string; valor: number; meio?: string }) {
    if (!body.valor || body.valor <= 0) throw new BadRequestException('Valor da saída deve ser maior que zero');
    if (!body.descricao?.trim()) throw new BadRequestException('Descrição da saída é obrigatória');

    const { data: caixa } = await this.supabase.client
      .from('caixas').select('id, saidas').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();
    if (!caixa) throw new NotFoundException('Nenhum caixa aberto');

    const saidas = (caixa.saidas ?? []) as any[];
    const nova: any = { descricao: body.descricao.trim(), valor: Number(body.valor), criado_em: new Date().toISOString() };
    if (body.meio) nova.meio = body.meio;
    const { error } = await this.supabase.client.from('caixas').update({ saidas: [...saidas, nova] }).eq('id', caixa.id);
    if (error) throw error;
    return nova;
  }

  async adicionarEntrada(restaurantId: number, body: { descricao: string; valor: number; meio?: string }) {
    if (!body.valor || body.valor <= 0) throw new BadRequestException('Valor da entrada deve ser maior que zero');
    if (!body.descricao?.trim()) throw new BadRequestException('Descrição da entrada é obrigatória');

    const { data: caixa } = await this.supabase.client
      .from('caixas').select('id, entradas').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();
    if (!caixa) throw new NotFoundException('Nenhum caixa aberto');

    const entradas = (caixa.entradas ?? []) as any[];
    const nova: any = { descricao: body.descricao.trim(), valor: Number(body.valor), criado_em: new Date().toISOString() };
    if (body.meio) nova.meio = body.meio;
    const { error } = await this.supabase.client.from('caixas').update({ entradas: [...entradas, nova] }).eq('id', caixa.id);
    if (error) throw error;
    return nova;
  }

  async relatorioFretes(restaurantId: number, periodo: 'hoje' | 'semana' | 'mes' | 'ano' | 'tudo') {
    const agora = new Date();
    let dataInicio: string | null = null;

    if (periodo === 'hoje') {
      const d = new Date(agora); d.setHours(0, 0, 0, 0);
      dataInicio = d.toISOString();
    } else if (periodo === 'semana') {
      const d = new Date(agora); d.setDate(d.getDate() - 7);
      dataInicio = d.toISOString();
    } else if (periodo === 'mes') {
      const d = new Date(agora); d.setDate(1); d.setHours(0, 0, 0, 0);
      dataInicio = d.toISOString();
    } else if (periodo === 'ano') {
      const d = new Date(agora); d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
      dataInicio = d.toISOString();
    }

    let q = this.supabase.client
      .from('orders')
      .select('id, total, frete_cobrado, troco_para, payment_method, status, created_at, motoboy_id, motoboys(name)')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'delivered');

    if (dataInicio) q = q.gte('created_at', dataInicio);

    const { data: pedidos, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;

    const todos = pedidos ?? [];
    const total_fretes = todos.reduce((s: number, p: any) => s + parseFloat(p.frete_cobrado ?? 0), 0);
    const total_troco = todos.reduce((s: number, p: any) => {
      const troco = parseFloat(p.troco_para ?? 0) - parseFloat(p.total ?? 0);
      return s + (troco > 0 ? troco : 0);
    }, 0);
    const qtd_entregas = todos.length;

    // Agrupamento por motoboy
    const porMotoboy: Record<string, any> = {};
    for (const p of todos) {
      const nome = (p.motoboys as any)?.name ?? 'Sem motoboy';
      const mid = p.motoboy_id ?? 0;
      const key = String(mid);
      if (!porMotoboy[key]) porMotoboy[key] = { motoboy_id: mid, nome, fretes: 0, troco: 0, entregas: 0 };
      porMotoboy[key].fretes += parseFloat(p.frete_cobrado ?? 0);
      const troco = parseFloat(p.troco_para ?? 0) - parseFloat(p.total ?? 0);
      porMotoboy[key].troco += troco > 0 ? troco : 0;
      porMotoboy[key].entregas += 1;
    }

    // Agrupamento por dia
    const porDia: Record<string, any> = {};
    for (const p of todos) {
      const dia = new Date(p.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      if (!porDia[dia]) porDia[dia] = { dia, fretes: 0, troco: 0, entregas: 0 };
      porDia[dia].fretes += parseFloat(p.frete_cobrado ?? 0);
      const troco = parseFloat(p.troco_para ?? 0) - parseFloat(p.total ?? 0);
      porDia[dia].troco += troco > 0 ? troco : 0;
      porDia[dia].entregas += 1;
    }

    return {
      periodo,
      total_fretes: parseFloat(total_fretes.toFixed(2)),
      total_troco: parseFloat(total_troco.toFixed(2)),
      qtd_entregas,
      por_motoboy: Object.values(porMotoboy),
      por_dia: Object.values(porDia),
    };
  }

  async setFreteGratis(restaurantId: number, pedidoId: number) {
    const { data: pedido, error: errGet } = await this.supabase.client
      .from('orders')
      .select('id, total, frete_cobrado, status')
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (errGet) throw errGet;
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    if (['delivered', 'canceled'].includes(pedido.status)) {
      throw new BadRequestException('Não é possível alterar pedido finalizado');
    }

    const frete = parseFloat(pedido.frete_cobrado ?? 0);
    if (frete === 0) return { message: 'Frete já é zero', pedido };

    const novoTotal = parseFloat((Number(pedido.total) - frete).toFixed(2));

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ frete_cobrado: 0, total: novoTotal })
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .select('id, total, frete_cobrado')
      .single();

    if (error) throw error;
    return data;
  }

  async setTrocoPara(restaurantId: number, pedidoId: number, trocoPara: number) {
    if (!trocoPara || trocoPara <= 0) throw new BadRequestException('Valor inválido');
    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ troco_para: trocoPara })
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .select('id, total, troco_para');
    if (error) throw error;
    if (!data?.length) throw new NotFoundException('Pedido não encontrado');
    return data[0];
  }

  async uploadImage(folder: string, file: Express.Multer.File) {
    const BUCKET = 'restaurante-imagens';
    await this.setupStorage();

    const ext = (file.originalname.split('.').pop() ?? 'jpg').toLowerCase();
    const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .upload(path, file.buffer, { cacheControl: '3600', upsert: false, contentType: file.mimetype });

    if (error) throw error;

    const { data } = this.supabase.client.storage.from(BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  }

  async setupStorage() {
    const BUCKET = 'restaurante-imagens';
    const { data: buckets } = await this.supabase.client.storage.listBuckets();
    const exists = (buckets ?? []).some((b: any) => b.id === BUCKET);

    if (!exists) {
      const { error } = await this.supabase.client.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
      });
      if (error) throw error;
    }
    return { ok: true, bucket: BUCKET, criado: !exists };
  }

  async getRelatorio(restaurantId: number, de: string, ate: string) {
    const { data: orders, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, payment_method, canal, created_at, customer_id, customers(name)')
      .eq('restaurant_id', restaurantId)
      .gte('created_at', de)
      .lte('created_at', ate)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const orderIds = (orders ?? []).map((o: any) => o.id);

    if (orderIds.length === 0) {
      const { data: caixasVazio } = await this.supabase.client
        .from('caixas').select('id, saidas').eq('restaurant_id', restaurantId)
        .lte('aberto_em', ate).or(`fechado_em.is.null,fechado_em.gte.${de}`);
      const deD = new Date(de); const ateD = new Date(ate);
      const saidasVazio: any[] = [];
      for (const c of (caixasVazio ?? [])) {
        for (const s of (c.saidas ?? [])) {
          const d = new Date(s.criado_em);
          if (d >= deD && d <= ateD) saidasVazio.push(s);
        }
      }
      const totalSaidasVazio = saidasVazio.reduce((sum, s) => sum + (s.valor ?? 0), 0);
      return {
        pedidos: [],
        saidas: saidasVazio,
        resumo: { total_pedidos: 0, entregues: 0, cancelados: 0, em_andamento: 0, total_vendas: 0, ticket_medio: 0, por_pagamento: {}, total_saidas: totalSaidasVazio, saldo_liquido: -totalSaidasVazio },
      };
    }

    const { data: allItems } = await this.supabase.client
      .from('order_items')
      .select('id, order_id, product_id, quantity, unit_price')
      .in('order_id', orderIds);

    const productIds = [...new Set<number>((allItems ?? []).map((i: any) => i.product_id))];
    const { data: allProds } = productIds.length > 0
      ? await this.supabase.client.from('products').select('id, name').in('id', productIds)
      : { data: [] };

    const prodMap = Object.fromEntries((allProds ?? []).map((p: any) => [p.id, p.name]));
    const itemsByOrder = (allItems ?? []).reduce((acc: any, item: any) => {
      if (!acc[item.order_id]) acc[item.order_id] = [];
      acc[item.order_id].push({ ...item, product_name: prodMap[item.product_id] ?? `#${item.product_id}` });
      return acc;
    }, {});

    const pedidos = (orders ?? []).map((o: any) => ({ ...o, itens: itemsByOrder[o.id] ?? [] }));

    const entregues = pedidos.filter((p: any) => this.STATUS_VENDA_FINALIZADA.includes(p.status));
    const cancelados = pedidos.filter((p: any) => p.status === 'canceled');
    const em_andamento = pedidos.filter((p: any) => !['canceled', 'delivered', 'paga'].includes(p.status));
    const nao_cancelados = pedidos.filter((p: any) => p.status !== 'canceled');
    const total_vendas = entregues.reduce((s: number, p: any) => s + (p.total ?? 0), 0);
    const pagamentosPorComandaRelatorio = await this.buscarPagamentosPorComanda(nao_cancelados);
    const por_pagamento = nao_cancelados.reduce((acc: any, p: any) => {
      const pagamentosComanda = p.canal === 'presencial' ? pagamentosPorComandaRelatorio.get(p.id) : undefined;
      if (pagamentosComanda?.length) {
        for (const pag of pagamentosComanda) {
          const m = pag.forma_pagamento ?? 'unknown';
          if (!acc[m]) acc[m] = { count: 0, total: 0 };
          acc[m].count++;
          acc[m].total += pag.valor ?? 0;
        }
        return acc;
      }
      const m = p.payment_method ?? 'unknown';
      if (!acc[m]) acc[m] = { count: 0, total: 0 };
      acc[m].count++;
      acc[m].total += p.total ?? 0;
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    // Saídas de caixas que se sobrepõem ao período
    const { data: caixasPeriodo } = await this.supabase.client
      .from('caixas')
      .select('id, saidas')
      .eq('restaurant_id', restaurantId)
      .lte('aberto_em', ate)
      .or(`fechado_em.is.null,fechado_em.gte.${de}`);

    const deDate = new Date(de);
    const ateDate = new Date(ate);
    const saidas: any[] = [];
    for (const c of (caixasPeriodo ?? [])) {
      for (const s of (c.saidas ?? [])) {
        const d = new Date(s.criado_em);
        if (d >= deDate && d <= ateDate) saidas.push(s);
      }
    }
    const total_saidas = saidas.reduce((sum, s) => sum + (s.valor ?? 0), 0);

    return {
      pedidos,
      saidas,
      resumo: {
        total_pedidos: pedidos.length,
        entregues: entregues.length,
        cancelados: cancelados.length,
        em_andamento: em_andamento.length,
        total_vendas,
        ticket_medio: entregues.length > 0 ? total_vendas / entregues.length : 0,
        por_pagamento,
        total_saidas,
        saldo_liquido: total_vendas - total_saidas,
      },
    };
  }

  async buscarPedidoDoRestaurante(restaurantId: number, pedidoId: number) {
    const resultado = await this.pedidos.buscar(pedidoId);
    if (resultado.pedido.restaurant_id !== restaurantId) {
      throw new NotFoundException('Pedido não encontrado neste restaurante');
    }

    if (resultado.itens.length > 0) {
      const prodIds = resultado.itens.map((i: any) => i.product_id);
      const { data: produtos } = await this.supabase.client
        .from('products')
        .select('id, name')
        .in('id', prodIds);
      const prodMap = Object.fromEntries((produtos ?? []).map((p: any) => [p.id, p.name]));
      resultado.itens = resultado.itens.map((i: any) => ({
        ...i,
        product_name: prodMap[i.product_id] ?? `Produto #${i.product_id}`,
      }));
    }

    return resultado;
  }
}

import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from '../motoboy/geocoding.service';
import { SalaoService } from '../salao/salao.service';
import { EstoqueService } from '../estoque/estoque.service';
import { CombosService, ItemExpandido } from '../combos/combos.service';

const STATUS_VALIDOS = ['pending', 'confirmed', 'preparing', 'ready', 'motoboy_collecting', 'out_for_delivery', 'delivered', 'canceled'] as const;
type Status = typeof STATUS_VALIDOS[number];

@Injectable()
export class PedidosService {
  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
    private salaoService: SalaoService,
    private estoque: EstoqueService,
    private combos: CombosService,
  ) {}

  // Roteia os itens do pedido delivery pro mesmo mecanismo de KDS por setor que o
  // módulo Salão já usa: copia impressora_id do produto pro item, marca status
  // "enviado" (aparece em Produção/Bar/Cozinha filtrado por setor) e gera job de
  // impressão por setor pras impressoras com agente local pareado. Idempotente —
  // só processa item que ainda não foi enviado (enviado_em null), então pode chamar
  // de novo sem duplicar (ex: pedido volta de "confirmed" -> "pending" -> "confirmed").
  private async rotearItensParaSetor(pedidoId: number, restauranteId: number) {
    const { data: pendentes, error } = await this.supabase.client
      .from('order_items')
      .select('id, quantity, products(name, description, impressora_id, impressoras(id, nome, setor, nome_sistema))')
      .eq('order_id', pedidoId)
      .is('enviado_em', null);
    if (error) throw error;
    if (!pendentes?.length) return;

    const agora = new Date().toISOString();
    await this.supabase.client
      .from('order_items')
      .update({ status: 'enviado', enviado_em: agora })
      .in('id', pendentes.map((p: any) => p.id));

    for (const item of pendentes as any[]) {
      const impressoraId = item.products?.impressora_id ?? null;
      if (impressoraId) {
        await this.supabase.client.from('order_items').update({ impressora_id: impressoraId }).eq('id', item.id);
      }
    }

    const grupos = new Map<string, { setor: string; impressora_id: number; nome_sistema: string | null; itens: any[] }>();
    for (const item of pendentes as any[]) {
      const impressora = item.products?.impressoras;
      if (!impressora?.id) continue; // produto sem impressora configurada — não gera job
      const chave = String(impressora.id);
      if (!grupos.has(chave)) {
        grupos.set(chave, { setor: impressora.setor, impressora_id: impressora.id, nome_sistema: impressora.nome_sistema ?? null, itens: [] });
      }
      grupos.get(chave)!.itens.push({
        product_name: item.products?.name,
        description: item.products?.description,
        quantity: item.quantity,
      });
    }

    const comandaLike = { cliente_mesa_nome: `Pedido delivery #${pedidoId}` };
    for (const grupo of grupos.values()) {
      if (!grupo.nome_sistema) continue; // sem agente local pareado — sem job, staff reimprime pela tela do setor
      const conteudo = this.salaoService.formatarTicketTexto(grupo.setor, comandaLike, grupo.itens);
      const { error: errJob } = await this.supabase.client.from('impressao_jobs').insert({
        restaurant_id: restauranteId,
        impressora_id: grupo.impressora_id,
        conteudo,
      });
      if (errJob) throw errJob;
    }
  }

  private async geocodificarEnderecoCliente(customerId: number) {
    const { data: customer } = await this.supabase.client
      .from('customers')
      .select('address_json, address_geocode_hash')
      .eq('id', customerId)
      .maybeSingle();
    if (!customer) return;

    const resultado = await this.geocoding.geocodificarSeNecessario(customer.address_json, customer.address_geocode_hash);
    if (!resultado) return;

    await this.supabase.client
      .from('customers')
      .update({
        lat: resultado.lat,
        lng: resultado.lng,
        address_geocode_hash: resultado.hash,
        address_geocoded_at: new Date().toISOString(),
      })
      .eq('id', customerId);
  }

  async listar(filtros: {
    empresa_id?: number;
    status?: string;
    user_id?: string;
    data_inicio?: string;
    data_fim?: string;
    limite?: number;
  }) {
    let query = this.supabase.client
      .from('orders')
      .select('id, total, frete_cobrado, status, payment_method, restaurant_id, customer_id, user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(filtros.limite ?? 50);

    if (filtros.empresa_id) query = query.eq('restaurant_id', filtros.empresa_id);
    if (filtros.status) query = query.eq('status', filtros.status);
    if (filtros.user_id) query = query.eq('user_id', filtros.user_id);
    if (filtros.data_inicio) query = query.gte('created_at', filtros.data_inicio);
    if (filtros.data_fim) query = query.lte('created_at', filtros.data_fim + 'T23:59:59');

    const { data, error } = await query;
    if (error) throw error;
    return { pedidos: data, total: data?.length ?? 0 };
  }

  async buscar(id: number) {
    const { data: pedido, error } = await this.supabase.client
      .from('orders')
      .select('id, total, troco_para, frete_cobrado, entrega_pagamento, status, payment_method, restaurant_id, customer_id, user_id, motoboy_id, motoboy_lat, motoboy_lng, motoboy_location_at, delivery_notes, delivery_occurrence, cancel_reason, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!pedido) throw new NotFoundException(`Pedido ${id} não encontrado`);

    const [{ data: itensRaw }, { data: cliente }, { data: empresa }, { data: motoboy }, { data: pagamento }] = await Promise.all([
      this.supabase.client
        .from('order_items')
        .select('id, quantity, unit_price, product_id, combo_nome, combo_quantidade, status, enviado_em, preparando_em')
        .eq('order_id', id),
      pedido.customer_id
        ? this.supabase.client.from('customers').select('id, name, email, phone_e164, address_json').eq('id', pedido.customer_id).maybeSingle()
        : Promise.resolve({ data: null }),
      this.supabase.client
        .from('restaurants')
        .select('id, name, comissao_pct, address')
        .eq('id', pedido.restaurant_id)
        .maybeSingle(),
      pedido.motoboy_id
        ? this.supabase.client.from('motoboys').select('id, name, phone, access_token').eq('id', pedido.motoboy_id).maybeSingle()
        : Promise.resolve({ data: null }),
      this.supabase.client.from('pagamentos').select('id, valor, tipo, status').eq('order_id', id).eq('status', 'paid').maybeSingle(),
    ]);

    // Enrich items with product names
    let itens = itensRaw ?? [];
    if (itens.length > 0) {
      const prodIds = itens.map((i: any) => i.product_id);
      const { data: prods } = await this.supabase.client.from('products').select('id, name').in('id', prodIds);
      const prodMap = Object.fromEntries((prods ?? []).map((p: any) => [p.id, p.name]));
      itens = itens.map((i: any) => ({ ...i, product_name: prodMap[i.product_id] ?? `Produto #${i.product_id}` }));
    }

    return { pedido, itens, cliente, empresa, motoboy, pagamento_pago: pagamento ?? null };
  }

  async criar(body: {
    restaurant_id: number;
    customer_id?: number;
    payment_method: string;
    troco_para?: number;
    user_id: string;
    itens: { product_id?: number; combo_id?: number; quantity: number }[];
  }) {
    if (!body.itens?.length) throw new BadRequestException('Pedido precisa de pelo menos 1 item');

    const itensDiretos = body.itens.filter((i) => i.product_id != null);
    const itensCombo = body.itens.filter((i) => i.combo_id != null);

    // Busca preços dos produtos vendidos diretamente (fora de combo)
    const prodIds = itensDiretos.map((i) => i.product_id as number);
    const { data: produtos, error: errProd } = await this.supabase.client
      .from('products')
      .select('id, price, is_active')
      .in('id', prodIds.length ? prodIds : [0]);

    if (errProd) throw errProd;

    const prodMap = Object.fromEntries((produtos ?? []).map((p) => [p.id, p]));

    for (const item of itensDiretos) {
      const prod = prodMap[item.product_id as number];
      if (!prod) throw new BadRequestException(`Produto ${item.product_id} não encontrado`);
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} inativo`);
    }

    // Combo não é vendável direto — vira as linhas dos produtos reais que o compõem,
    // com preço escalado pra bater o valor promocional do combo (ver CombosService).
    const linhasCombo: ItemExpandido[] = (
      await Promise.all(itensCombo.map((i) => this.combos.expandir(i.combo_id as number, i.quantity, body.restaurant_id)))
    ).flat();

    const linhasDiretas: ItemExpandido[] = itensDiretos.map((item) => ({
      product_id: item.product_id as number,
      quantity: item.quantity,
      unit_price: prodMap[item.product_id as number].price,
    }));

    const linhasFinais = [...linhasDiretas, ...linhasCombo];

    const subtotal = linhasFinais.reduce((acc, l) => acc + l.unit_price * l.quantity, 0);

    // Busca frete do restaurante e soma ao total
    const { data: rest } = await this.supabase.client
      .from('restaurants')
      .select('frete_motoboy, motoboy_comissao_tipo')
      .eq('id', body.restaurant_id)
      .maybeSingle();

    const frete = parseFloat(rest?.frete_motoboy ?? 0);
    const total = subtotal + frete;

    // Resolve customer_id — busca existente ou cria novo ao primeiro pedido
    let customerId = body.customer_id ?? null;
    if (!customerId && body.user_id) {
      const { data: c } = await this.supabase.client
        .from('customers')
        .select('id')
        .eq('user_id', body.user_id)
        .maybeSingle();

      if (c) {
        customerId = c.id;
      } else {
        // Cria registro de cliente usando dados do user_profile
        const { data: profile } = await this.supabase.client
          .from('user_profiles')
          .select('name, email')
          .eq('id', body.user_id)
          .maybeSingle();

        const { data: novoCliente } = await this.supabase.client
          .from('customers')
          .insert({
            user_id: body.user_id,
            name: profile?.name ?? 'Cliente',
            email: profile?.email ?? null,
          })
          .select('id')
          .single();

        if (novoCliente) customerId = novoCliente.id;
      }
    }

    // Geocodifica o endereço do cliente em background (best-effort) — só quando a comissão
    // do motoboy for por km, pra não gastar chamadas do Nominatim à toa. Nunca trava o checkout.
    if (customerId && rest?.motoboy_comissao_tipo === 'km') {
      this.geocodificarEnderecoCliente(customerId).catch(() => {});
    }

    // Busca caixa aberto para vincular o pedido
    const { data: caixaAberto } = await this.supabase.client
      .from('caixas')
      .select('id')
      .eq('restaurant_id', body.restaurant_id)
      .eq('status', 'aberto')
      .maybeSingle();

    // Cria pedido
    const { data: pedido, error: errPedido } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: body.restaurant_id,
        customer_id: customerId,
        payment_method: body.payment_method,
        troco_para: body.payment_method === 'cash' && body.troco_para ? body.troco_para : null,
        user_id: body.user_id,
        total: parseFloat(total.toFixed(2)),
        frete_cobrado: parseFloat(frete.toFixed(2)),
        status: 'pending',
        caixa_id: caixaAberto?.id ?? null,
      })
      .select()
      .single();

    if (errPedido) throw errPedido;

    // Cria itens — combo já chega explodido nas linhas dos produtos reais (linhasFinais)
    const itensPrepared = linhasFinais.map((l) => ({
      order_id: pedido.id,
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
      combo_nome: l.combo_nome ?? null,
      combo_quantidade: l.combo_quantidade ?? null,
    }));

    const { error: errItens } = await this.supabase.client
      .from('order_items')
      .insert(itensPrepared);

    if (errItens) throw errItens;

    // Reserva o estoque assim que o pedido é criado — evita vender 2x o último item
    // enquanto ele ainda está pendente de confirmação. Já é por produto real, então
    // cobre item vendido direto e item vindo de combo igual.
    await this.estoque.decrementarItens(linhasFinais);

    return { pedido, itens: itensPrepared };
  }

  async atualizarStatus(id: number, status: Status) {
    if (!STATUS_VALIDOS.includes(status)) {
      throw new BadRequestException(`Status inválido: ${status}`);
    }

    const { data: antes } = await this.supabase.client.from('orders').select('status').eq('id', id).maybeSingle();
    const statusAnterior = antes?.status;

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, status, total, restaurant_id, updated_at')
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Pedido ${id} não encontrado`);

    if (status === 'confirmed') {
      await this.rotearItensParaSetor(id, data.restaurant_id);
    }

    if (status === 'canceled' && statusAnterior !== 'canceled') {
      await this.estoque.restaurarItensDoPedido(id);
    }

    // Comissão registrada automaticamente via trigger on_order_delivered quando status = 'delivered'
    return data;
  }

  async cancelar(id: number) {
    return this.atualizarStatus(id, 'canceled');
  }

  async cancelarCliente(id: number, userId: string, motivo: string) {
    if (!motivo?.trim()) throw new BadRequestException('Motivo do cancelamento é obrigatório');

    const { data: pedido, error } = await this.supabase.client
      .from('orders')
      .select('id, status, user_id, total, payment_method')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!pedido) throw new NotFoundException(`Pedido ${id} não encontrado`);
    if (pedido.user_id !== userId) throw new ForbiddenException('Sem permissão para cancelar este pedido');
    if (!['pending', 'confirmed'].includes(pedido.status)) {
      throw new BadRequestException('Pedido não pode ser cancelado após início do preparo');
    }

    const { data: pagamento } = await this.supabase.client
      .from('pagamentos')
      .select('id, valor, tipo')
      .eq('order_id', id)
      .eq('status', 'paid')
      .maybeSingle();

    const { data: atualizado, error: errUpd } = await this.supabase.client
      .from('orders')
      .update({ status: 'canceled', cancel_reason: motivo.trim(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, status, cancel_reason, total, updated_at')
      .single();

    if (errUpd) throw errUpd;

    await this.estoque.restaurarItensDoPedido(id);

    const valor_devolver = pagamento?.valor ?? 0;
    return {
      pedido: atualizado,
      valor_devolver,
      precisa_estorno: valor_devolver > 0,
    };
  }
}

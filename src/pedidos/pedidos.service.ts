import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const STATUS_VALIDOS = ['pending', 'confirmed', 'preparing', 'ready', 'motoboy_collecting', 'out_for_delivery', 'delivered', 'canceled'] as const;
type Status = typeof STATUS_VALIDOS[number];

@Injectable()
export class PedidosService {
  constructor(private supabase: SupabaseService) {}

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
        .select('id, quantity, unit_price, product_id')
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
    itens: { product_id: number; quantity: number }[];
  }) {
    if (!body.itens?.length) throw new BadRequestException('Pedido precisa de pelo menos 1 item');

    // Busca preços dos produtos
    const prodIds = body.itens.map((i) => i.product_id);
    const { data: produtos, error: errProd } = await this.supabase.client
      .from('products')
      .select('id, price, is_active')
      .in('id', prodIds);

    if (errProd) throw errProd;

    const prodMap = Object.fromEntries((produtos ?? []).map((p) => [p.id, p]));

    for (const item of body.itens) {
      const prod = prodMap[item.product_id];
      if (!prod) throw new BadRequestException(`Produto ${item.product_id} não encontrado`);
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} inativo`);
    }

    const subtotal = body.itens.reduce((acc, item) => {
      return acc + prodMap[item.product_id].price * item.quantity;
    }, 0);

    // Busca frete do restaurante e soma ao total
    const { data: rest } = await this.supabase.client
      .from('restaurants')
      .select('frete_motoboy')
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

    // Cria itens
    const itensPrepared = body.itens.map((item) => ({
      order_id: pedido.id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: prodMap[item.product_id].price,
    }));

    const { error: errItens } = await this.supabase.client
      .from('order_items')
      .insert(itensPrepared);

    if (errItens) throw errItens;

    return { pedido, itens: itensPrepared };
  }

  async atualizarStatus(id: number, status: Status) {
    if (!STATUS_VALIDOS.includes(status)) {
      throw new BadRequestException(`Status inválido: ${status}`);
    }

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, status, total, restaurant_id, updated_at')
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Pedido ${id} não encontrado`);

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

    const valor_devolver = pagamento?.valor ?? 0;
    return {
      pedido: atualizado,
      valor_devolver,
      precisa_estorno: valor_devolver > 0,
    };
  }
}

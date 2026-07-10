import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MotoboyService {
  constructor(private supabase: SupabaseService) {}

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboys')
      .select('id, name, phone, access_token, is_active, created_at')
      .eq('restaurant_id', restaurantId)
      .order('name');
    if (error) throw error;
    return { motoboys: data ?? [] };
  }

  async criar(restaurantId: number, body: { name: string; phone?: string }) {
    const { data, error } = await this.supabase.client
      .from('motoboys')
      .insert({ restaurant_id: restaurantId, name: body.name, phone: body.phone ?? null })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async renovarToken(id: number, restaurantId: number) {
    const novoToken = crypto.randomUUID();
    const { data, error } = await this.supabase.client
      .from('motoboys')
      .update({ access_token: novoToken })
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .select('id, name, phone, access_token, is_active')
      .single();
    if (error) throw error;
    return data;
  }

  async toggle(id: number, restaurantId: number, ativo: boolean) {
    const { data, error } = await this.supabase.client
      .from('motoboys')
      .update({ is_active: ativo })
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async atribuir(pedidoId: number, restaurantId: number, motoboyId: number) {
    const { data: mb } = await this.supabase.client
      .from('motoboys')
      .select('id')
      .eq('id', motoboyId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!mb) throw new NotFoundException('Motoboy não encontrado neste restaurante');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'out_for_delivery', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { ok: true, status: 'out_for_delivery' };
  }

  // Motoboy portal
  async meusPedidos(motoboyId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, troco_para, status, payment_method, created_at, updated_at, motoboy_lat, motoboy_lng, customer_id, delivery_notes, delivery_occurrence')
      .eq('motoboy_id', motoboyId)
      .not('status', 'in', '("delivered","canceled")')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const pedidos = await Promise.all(
      (data ?? []).map(async (p) => {
        const [{ data: c }, { data: itensRaw }] = await Promise.all([
          p.customer_id
            ? this.supabase.client
                .from('customers')
                .select('name, phone_e164, address_json')
                .eq('id', p.customer_id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          this.supabase.client
            .from('order_items')
            .select('id, quantity, unit_price, product_id')
            .eq('order_id', p.id),
        ]);

        // Enrich items with product names
        let itens = itensRaw ?? [];
        if (itens.length > 0) {
          const prodIds = itens.map((i: any) => i.product_id);
          const { data: prods } = await this.supabase.client
            .from('products')
            .select('id, name')
            .in('id', prodIds);
          const prodMap = Object.fromEntries((prods ?? []).map((pr: any) => [pr.id, pr.name]));
          itens = itens.map((i: any) => ({ ...i, product_name: prodMap[i.product_id] ?? `Produto #${i.product_id}` }));
        }

        return { ...p, cliente: c, itens };
      }),
    );
    return { pedidos };
  }

  async atualizarLocalizacao(pedidoId: number, motoboyId: number, lat: number, lng: number) {
    const { error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_lat: lat, motoboy_lng: lng, motoboy_location_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId);
    if (error) throw error;
    return { ok: true };
  }

  async confirmarEntrega(
    pedidoId: number,
    motoboyId: number,
    entregaPagamento?: { metodo: string; dinheiro?: number; pix?: number },
  ) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, total')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const updatePayload: Record<string, any> = { status: 'delivered', updated_at: new Date().toISOString() };
    if (entregaPagamento) updatePayload.entrega_pagamento = entregaPagamento;

    const { error } = await this.supabase.client
      .from('orders')
      .update(updatePayload)
      .eq('id', pedidoId);
    if (error) throw error;

    // Registrar entrada(s) no caixa aberto
    if (entregaPagamento && pedido.restaurant_id) {
      const { data: caixa } = await this.supabase.client
        .from('caixas')
        .select('id, entradas')
        .eq('restaurant_id', pedido.restaurant_id)
        .eq('status', 'aberto')
        .maybeSingle();

      if (caixa) {
        const entradas = (caixa.entradas ?? []) as any[];
        const novas: any[] = [];
        const agora = new Date().toISOString();

        if ((entregaPagamento.dinheiro ?? 0) > 0) {
          novas.push({
            descricao: `Entrega pedido #${pedidoId} — dinheiro`,
            valor: entregaPagamento.dinheiro,
            meio: 'dinheiro',
            criado_em: agora,
          });
        }
        if ((entregaPagamento.pix ?? 0) > 0) {
          novas.push({
            descricao: `Entrega pedido #${pedidoId} — PIX`,
            valor: entregaPagamento.pix,
            meio: 'pix',
            criado_em: agora,
          });
        }

        if (novas.length > 0) {
          await this.supabase.client
            .from('caixas')
            .update({ entradas: [...entradas, ...novas] })
            .eq('id', caixa.id);
        }
      }
    }

    return { ok: true, pedido_id: pedidoId, status: 'delivered' };
  }

  async registrarOcorrencia(
    pedidoId: number,
    motoboyId: number,
    tipo: 'pendente' | 'cancelada',
    motivo: string,
  ) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, status')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const update: Record<string, any> = {
      delivery_notes: motivo.trim(),
      delivery_occurrence: tipo,
      updated_at: new Date().toISOString(),
    };
    // Cancelada muda o status; pendente mantém out_for_delivery para nova tentativa
    if (tipo === 'cancelada') update.status = 'canceled';

    const { error } = await this.supabase.client
      .from('orders')
      .update(update)
      .eq('id', pedidoId);
    if (error) throw error;

    return { ok: true, pedido_id: pedidoId, tipo, status: update.status ?? pedido.status };
  }

  async pedidosDisponiveis(motoboyId: number) {
    const mb = await this.infoMotoboy(motoboyId);
    if (!mb) throw new NotFoundException('Motoboy não encontrado');

    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, payment_method, created_at, customer_id')
      .eq('restaurant_id', mb.restaurant_id)
      .eq('status', 'ready')
      .is('motoboy_id', null)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const pedidos = await Promise.all(
      (data ?? []).map(async (p) => {
        const { data: c } = p.customer_id
          ? await this.supabase.client
              .from('customers')
              .select('name, phone_e164, address_json')
              .eq('id', p.customer_id)
              .maybeSingle()
          : { data: null };
        const { data: itensRaw } = await this.supabase.client
          .from('order_items')
          .select('id, quantity, unit_price, product_id')
          .eq('order_id', p.id);
        return { ...p, cliente: c, itens: itensRaw ?? [] };
      }),
    );
    return { pedidos };
  }

  async pegarPedido(pedidoId: number, motoboyId: number) {
    const mb = await this.infoMotoboy(motoboyId);
    if (!mb) throw new NotFoundException('Motoboy não encontrado');

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'motoboy_collecting', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', mb.restaurant_id)
      .eq('status', 'ready')
      .is('motoboy_id', null)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new ConflictException('Pedido já foi pego por outro motoboy ou não está disponível');
    }
    return { ok: true, pedido_id: pedidoId, status: 'motoboy_collecting' };
  }

  async reivindicarPedido(pedidoId: number, motoboyId: number) {
    const mb = await this.infoMotoboy(motoboyId);
    if (!mb) throw new NotFoundException('Motoboy não encontrado');

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'motoboy_collecting', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', mb.restaurant_id)
      .in('status', ['ready', 'preparing', 'confirmed'])
      .is('motoboy_id', null)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new ConflictException('Pedido não encontrado, já foi atribuído ou não está disponível');
    }
    return { ok: true, pedido_id: pedidoId, status: 'motoboy_collecting' };
  }

  async confirmarColeta(pedidoId: number, motoboyId: number, barcode: string) {
    const expected = String(pedidoId).padStart(8, '0');
    const scanned  = barcode.replace(/\D/g, '').padStart(8, '0');
    if (scanned !== expected) {
      throw new BadRequestException('Código de barras não confere com este pedido');
    }

    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, total, troco_para, payment_method, restaurant_id')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .eq('status', 'motoboy_collecting')
      .maybeSingle();
    if (!pedido) throw new ConflictException('Pedido não está aguardando coleta ou não pertence a você');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ status: 'out_for_delivery', updated_at: new Date().toISOString() })
      .eq('id', pedidoId);
    if (error) throw error;

    // Troco: sangria automática quando motoboy leva o troco para o cliente
    const trocoValor = pedido.payment_method === 'cash' && pedido.troco_para > pedido.total
      ? Number(pedido.troco_para) - Number(pedido.total)
      : 0;
    if (trocoValor > 0) {
      const { data: caixa } = await this.supabase.client
        .from('caixas')
        .select('id, saidas')
        .eq('restaurant_id', pedido.restaurant_id)
        .eq('status', 'aberto')
        .maybeSingle();
      if (caixa) {
        const saidas = (caixa.saidas ?? []) as any[];
        const novaSaida = {
          descricao: `Troco pedido #${pedidoId}`,
          valor: trocoValor,
          meio: 'dinheiro',
          criado_em: new Date().toISOString(),
        };
        await this.supabase.client
          .from('caixas')
          .update({ saidas: [...saidas, novaSaida] })
          .eq('id', caixa.id);
      }
    }

    return { ok: true, pedido_id: pedidoId, status: 'out_for_delivery', troco: trocoValor };
  }

  async uploadComprovante(pedidoId: number, motoboyId: number, base64: string) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
    const mimeType = matches ? matches[1] : 'image/jpeg';
    const raw = matches ? matches[2] : base64;
    const buffer = Buffer.from(raw, 'base64');
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const path = `pedido-${pedidoId}-${Date.now()}.${ext}`;

    const { error: uploadError } = await this.supabase.client.storage
      .from('comprovantes-pix')
      .upload(path, buffer, { contentType: mimeType, upsert: true });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = this.supabase.client.storage
      .from('comprovantes-pix')
      .getPublicUrl(path);

    await this.supabase.client
      .from('orders')
      .update({ comprovante_pix_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', pedidoId);

    return { url: publicUrl };
  }

  async infoMotoboy(motoboyId: number) {
    const { data: mb } = await this.supabase.client
      .from('motoboys')
      .select('id, name, phone, restaurant_id')
      .eq('id', motoboyId)
      .maybeSingle();
    if (!mb) return null;

    const { data: rest } = await this.supabase.client
      .from('restaurants')
      .select('name, payment_config')
      .eq('id', mb.restaurant_id)
      .maybeSingle();

    return {
      ...mb,
      restaurante_nome: rest?.name ?? null,
      restaurante_cidade: null,
      chave_pix: (rest?.payment_config as any)?.chave_pix ?? null,
    };
  }
}

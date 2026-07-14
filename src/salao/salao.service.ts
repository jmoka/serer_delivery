import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface AbrirComandaBody {
  mesa_id?: number;
  cliente_nome: string;
  cliente_telefone: string;
}

export interface ItemComandaBody {
  product_id: number;
  quantity: number;
  observacao?: string;
}

@Injectable()
export class SalaoService {
  constructor(private supabase: SupabaseService) {}

  async mesas(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;
    return data;
  }

  // Acompanhamento público via QR (ideia 13) — sem auth, só o essencial pro cliente da mesa.
  async acompanharPorToken(token: string) {
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('id, status, mesas(numero, nome), restaurants(name)')
      .eq('tracking_token', token)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!comanda) throw new NotFoundException('Comanda não encontrada');

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('quantity, status, products(name)')
      .eq('order_id', comanda.id);

    return {
      restaurante: (comanda as any).restaurants?.name,
      mesa: (comanda as any).mesas ? `Mesa ${(comanda as any).mesas.numero}` : 'Comanda avulsa',
      status: comanda.status,
      itens: (itens ?? []).map((i: any) => ({ quantity: i.quantity, status: i.status, product_name: i.products?.name })),
    };
  }

  async produtos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, name, price, image_url, category_id, categories(name)')
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((p: any) => ({ ...p, category_name: p.categories?.name ?? 'Outros' }));
  }

  private async garantirComandaDoGarcom(comandaId: number, garcomId: number) {
    const { data } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, mesa_id, garcom_id')
      .eq('id', comandaId)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!data) throw new NotFoundException('Comanda não encontrada');
    if (data.garcom_id !== garcomId) throw new ForbiddenException('Comanda não pertence a este garçom');
    return data;
  }

  private async recalcularTotal(comandaId: number) {
    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('quantity, unit_price')
      .eq('order_id', comandaId);

    const total = (itens ?? []).reduce((acc, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client
      .from('orders')
      .update({ total: parseFloat(total.toFixed(2)) })
      .eq('id', comandaId);
  }

  async abrirComanda(garcomId: number, restaurantId: number, body: AbrirComandaBody) {
    if (!body.cliente_nome || !body.cliente_telefone) {
      throw new BadRequestException('Nome e telefone do cliente são obrigatórios');
    }

    let mesa: { id: number } | null = null;
    if (body.mesa_id) {
      const { data } = await this.supabase.client
        .from('mesas')
        .select('id, status')
        .eq('id', body.mesa_id)
        .eq('restaurant_id', restaurantId)
        .maybeSingle();
      if (!data) throw new NotFoundException('Mesa não encontrada');
      if (data.status !== 'livre') throw new BadRequestException('Mesa não está livre');
      mesa = data;
    }

    const { data: caixaAberto } = await this.supabase.client
      .from('caixas')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aberto')
      .maybeSingle();

    const { data: comanda, error } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        canal: 'presencial',
        status: 'aberta',
        garcom_id: garcomId,
        mesa_id: mesa?.id ?? null,
        cliente_mesa_nome: body.cliente_nome,
        cliente_mesa_telefone: body.cliente_telefone,
        total: 0,
        caixa_id: caixaAberto?.id ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    if (mesa) {
      await this.supabase.client.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id);
    }

    return comanda;
  }

  async minhasComandas(garcomId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, status, total, created_at')
      .eq('garcom_id', garcomId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async obterComanda(comandaId: number, garcomId: number) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: itens, error } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, observacao, status, enviado_em, products(name, image_url)')
      .eq('order_id', comandaId)
      .order('id', { ascending: true });
    if (error) throw error;

    return { ...comanda, itens };
  }

  async adicionarItens(comandaId: number, garcomId: number, itens: ItemComandaBody[]) {
    if (!itens?.length) throw new BadRequestException('Informe ao menos 1 item');

    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (comanda.status !== 'aberta') throw new BadRequestException('Comanda não está aberta');

    const prodIds = itens.map((i) => i.product_id);
    const { data: produtos, error: errProd } = await this.supabase.client
      .from('products')
      .select('id, price, is_active')
      .in('id', prodIds);
    if (errProd) throw errProd;

    const prodMap = Object.fromEntries((produtos ?? []).map((p) => [p.id, p]));
    for (const item of itens) {
      const prod = prodMap[item.product_id];
      if (!prod) throw new BadRequestException(`Produto ${item.product_id} não encontrado`);
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} inativo`);
    }

    const { error } = await this.supabase.client.from('order_items').insert(
      itens.map((i) => ({
        order_id: comandaId,
        product_id: i.product_id,
        quantity: i.quantity,
        unit_price: prodMap[i.product_id].price,
        observacao: i.observacao?.trim() || null,
        status: 'pendente',
      })),
    );
    if (error) throw error;

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
  }

  async enviarItens(comandaId: number, garcomId: number) {
    await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: pendentes, error } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, observacao, products(name, impressora_id, impressoras(id, nome, setor))')
      .eq('order_id', comandaId)
      .eq('status', 'pendente');
    if (error) throw error;
    if (!pendentes?.length) return { grupos: [] };

    const agora = new Date().toISOString();
    await this.supabase.client
      .from('order_items')
      .update({ status: 'enviado', enviado_em: agora })
      .in(
        'id',
        pendentes.map((p: any) => p.id),
      );

    for (const item of pendentes as any[]) {
      const impressoraId = item.products?.impressora_id ?? null;
      if (impressoraId) {
        await this.supabase.client.from('order_items').update({ impressora_id: impressoraId }).eq('id', item.id);
      }
    }

    const grupos = new Map<string, { setor: string; impressora_nome: string | null; itens: any[] }>();
    for (const item of pendentes as any[]) {
      const impressora = item.products?.impressoras;
      const chave = impressora?.id ? String(impressora.id) : 'sem-impressora';
      if (!grupos.has(chave)) {
        grupos.set(chave, { setor: impressora?.setor ?? 'Sem setor', impressora_nome: impressora?.nome ?? null, itens: [] });
      }
      grupos.get(chave)!.itens.push({ product_name: item.products?.name, quantity: item.quantity, observacao: item.observacao });
    }

    return { grupos: Array.from(grupos.values()) };
  }

  async fecharComanda(comandaId: number, garcomId: number, formaPagamento: string) {
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (comanda.status !== 'aberta') throw new BadRequestException('Comanda já foi fechada');

    const { data: itens } = await this.supabase.client.from('order_items').select('id').eq('order_id', comandaId);
    if (!itens?.length) throw new BadRequestException('Comanda sem itens não pode ser fechada');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ status: 'fechada_garcom', payment_method: formaPagamento })
      .eq('id', comandaId);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'aguardando_pagamento' }).eq('id', comanda.mesa_id);
    }

    return { ok: true };
  }
}

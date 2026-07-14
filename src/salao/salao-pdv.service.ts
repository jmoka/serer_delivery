import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// PDV do caixa (lado estabelecimento): ações de cancelar/desconto/acréscimo/pagar
// são exclusivas do dono (RestaurantOwnerGuard) — o garçom nunca tem acesso a
// essas rotas (ver salao.controller.ts, que só cobre abrir/adicionar/enviar/fechar).
@Injectable()
export class SalaoPdvService {
  constructor(private supabase: SupabaseService) {}

  async mesas(restaurantId: number) {
    const { data: mesas, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;

    const { data: comandas } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, total, status, garcons(nome)')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .not('mesa_id', 'is', null);

    const comandaPorMesa = new Map((comandas ?? []).map((c: any) => [c.mesa_id, c]));

    return (mesas ?? []).map((m: any) => ({ ...m, comanda: comandaPorMesa.get(m.id) ?? null }));
  }

  async comandasAbertas(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, total, status, payment_method, created_at, mesas(numero, nome), garcons(nome)')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  private async buscarComanda(id: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('orders')
      .select('*, mesas(numero, nome), garcons(id, nome)')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!data) throw new NotFoundException('Comanda não encontrada');
    return data;
  }

  async comandaDetalhe(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, status, enviado_em, products(name, image_url)')
      .eq('order_id', id)
      .order('id', { ascending: true });
    return { ...comanda, itens };
  }

  async aplicarDesconto(id: number, restaurantId: number, valor: number) {
    if (valor < 0) throw new BadRequestException('Desconto não pode ser negativo');
    await this.buscarComanda(id, restaurantId);
    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ desconto_valor: valor })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async aplicarAcrescimo(id: number, restaurantId: number, valor: number) {
    if (valor < 0) throw new BadRequestException('Acréscimo não pode ser negativo');
    await this.buscarComanda(id, restaurantId);
    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ acrescimo_valor: valor })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async cancelar(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Só é possível cancelar comandas abertas ou aguardando pagamento');
    }

    const { error } = await this.supabase.client.from('orders').update({ status: 'canceled' }).eq('id', id);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', comanda.mesa_id);
    }
    return { ok: true };
  }

  private async lancarComissoes(comanda: any, subtotal: number, totalFinal: number) {
    if (!comanda.garcom_id) return;

    const { data: configs } = await this.supabase.client
      .from('garcom_comissoes_config')
      .select('id, tipo, valor, base_calculo')
      .eq('restaurant_id', comanda.restaurant_id)
      .eq('ativo', true);
    if (!configs?.length) return;

    for (const config of configs) {
      const base = config.base_calculo === 'total_recebido' ? totalFinal : subtotal;
      const valorCalculado = config.tipo === 'percentual' ? (base * config.valor) / 100 : config.valor;

      await this.supabase.client.from('garcom_comissoes_lancamentos').insert({
        garcom_id: comanda.garcom_id,
        order_id: comanda.id,
        config_id: config.id,
        valor_calculado: parseFloat(valorCalculado.toFixed(2)),
      });
    }
  }

  async pagar(id: number, restaurantId: number, formaPagamento: string, gorjetaValor?: number) {
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    const comanda = await this.buscarComanda(id, restaurantId);
    if (comanda.status !== 'fechada_garcom' && comanda.status !== 'aberta') {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', id);
    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const totalFinal = subtotal - (comanda.desconto_valor ?? 0) + (comanda.acrescimo_valor ?? 0);

    let caixaId = comanda.caixa_id;
    if (!caixaId) {
      const { data: caixaAberto } = await this.supabase.client
        .from('caixas')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'aberto')
        .maybeSingle();
      caixaId = caixaAberto?.id ?? null;
    }

    const { error } = await this.supabase.client
      .from('orders')
      .update({
        status: 'paga',
        payment_method: formaPagamento,
        total: parseFloat(totalFinal.toFixed(2)),
        gorjeta_valor: gorjetaValor ?? null,
        caixa_id: caixaId,
      })
      .eq('id', id);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', comanda.mesa_id);
    }

    await this.lancarComissoes(comanda, subtotal, totalFinal);

    return { ok: true, total: parseFloat(totalFinal.toFixed(2)) };
  }
}

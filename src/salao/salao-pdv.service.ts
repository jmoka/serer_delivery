import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SalaoService } from './salao.service';
import type { ItemComandaBody } from './salao.service';

// PDV do caixa (lado estabelecimento): ações de cancelar/desconto/acréscimo/pagar
// são exclusivas do dono (RestaurantOwnerGuard) — o garçom nunca tem acesso a
// essas rotas (ver salao.controller.ts, que só cobre abrir/adicionar/enviar/fechar).
@Injectable()
export class SalaoPdvService {
  constructor(
    private supabase: SupabaseService,
    private salaoService: SalaoService,
  ) {}

  async mesas(restaurantId: number) {
    const { data: mesas, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;

    const { data: comandas } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, total, status, numero_comanda, cliente_mesa_nome, garcons(nome)')
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
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, total, status, payment_method, numero_comanda, created_at, mesas(numero, nome), garcons(nome)')
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
      .select('id, product_id, quantity, unit_price, observacao, status, enviado_em, products(name, image_url)')
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

  // Dono/caixa inclui item direto na comanda (o garçom não precisa estar envolvido) —
  // vai pendente e já sai imprimindo/pra fila igual quando o garçom manda.
  async adicionarItens(id: number, restaurantId: number, itens: ItemComandaBody[]) {
    if (!itens?.length) throw new BadRequestException('Informe ao menos 1 item');

    const comanda = await this.buscarComanda(id, restaurantId);
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
        order_id: id,
        product_id: i.product_id,
        quantity: i.quantity,
        unit_price: prodMap[i.product_id].price,
        observacao: i.observacao?.trim() || null,
        status: 'pendente',
      })),
    );
    if (error) throw error;

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', id);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', id);

    await this.salaoService.enviarItensComoRestaurante(id, comanda);
    return this.comandaDetalhe(id, restaurantId);
  }

  // Troca o garçom responsável por uma comanda em andamento (ex: troca de turno).
  async transferirGarcom(id: number, restaurantId: number, novoGarcomId: number) {
    await this.buscarComanda(id, restaurantId);

    const { data: garcom } = await this.supabase.client
      .from('garcons')
      .select('id, ativo')
      .eq('id', novoGarcomId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!garcom) throw new NotFoundException('Garçom não encontrado');
    if (!garcom.ativo) throw new BadRequestException('Garçom está desativado');

    const { error } = await this.supabase.client.from('orders').update({ garcom_id: novoGarcomId }).eq('id', id);
    if (error) throw error;
    return { ok: true };
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

  // Sugestão de gorjeta calculada a partir da % configurada no estabelecimento — o caixa
  // pode ver o valor sugerido antes de confirmar, mas ainda pode ajustar na hora de pagar.
  async sugestaoGorjeta(id: number, restaurantId: number) {
    await this.buscarComanda(id, restaurantId);
    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', id);
    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);

    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('gorjeta_percentual')
      .eq('id', restaurantId)
      .maybeSingle();
    const percentual = restaurante?.gorjeta_percentual ?? 0;

    return { percentual, valor_sugerido: parseFloat(((subtotal * percentual) / 100).toFixed(2)) };
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

import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// Sessão de trabalho do garçom ("turno"): abre sozinha quando ele abre a primeira comanda
// (ver garantirTurnoAberto, chamado por SalaoService.abrirComanda) e fecha quando ele faz
// "Sair" no portal (ver SalaoController). Não tem nenhuma relação com garcons.active_session_id
// (isso é só lock de dispositivo/login) — aqui é turno de trabalho mesmo, com vendas/gorjeta/
// comissão apuradas no intervalo [aberto_em, fechado_em] e congeladas em `resumo` no fechamento,
// igual já é feito com caixas.resumo.
@Injectable()
export class GarcomTurnoService {
  constructor(private supabase: SupabaseService) {}

  async turnoAtivo(garcomId: number) {
    const { data } = await this.supabase.client
      .from('garcom_turnos')
      .select('*')
      .eq('garcom_id', garcomId)
      .eq('status', 'aberto')
      .maybeSingle();
    return data ?? null;
  }

  async garantirTurnoAberto(garcomId: number, restaurantId: number) {
    const ativo = await this.turnoAtivo(garcomId);
    if (ativo) return ativo;

    const { data, error } = await this.supabase.client
      .from('garcom_turnos')
      .insert({ restaurant_id: restaurantId, garcom_id: garcomId })
      .select()
      .single();

    if (error) {
      // Corrida rara (duas comandas abertas quase ao mesmo tempo) — o índice único
      // (garcom_id) WHERE status='aberto' garante que só um insert vingou; pega esse.
      const existente = await this.turnoAtivo(garcomId);
      if (existente) return existente;
      throw error;
    }
    return data;
  }

  // Vendas/gorjeta/comissão do garçom no intervalo — mesmo recorte que
  // RestauranteService.getRelatorioGarcom já usa (orders.created_at no intervalo,
  // status='paga'), só que restrito a um garçom só.
  async resumoTurno(garcomId: number, restaurantId: number, desde: string, ate: string) {
    const { data: pedidos } = await this.supabase.client
      .from('orders')
      .select('id, total, status, gorjeta_valor, created_at, numero_comanda, cliente_mesa_nome, mesas(numero, nome)')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .eq('garcom_id', garcomId)
      .gte('created_at', desde)
      .lte('created_at', ate);

    const pedidosPagos = ((pedidos ?? []) as any[]).filter((p) => p.status === 'paga');
    const orderIds = pedidosPagos.map((p) => p.id);

    const { data: comissoes } = orderIds.length
      ? await this.supabase.client
          .from('garcom_comissoes_lancamentos')
          .select('order_id, valor_calculado')
          .in('order_id', orderIds)
      : { data: [] as any[] };

    const { data: itens } = orderIds.length
      ? await this.supabase.client
          .from('order_items')
          .select('order_id, quantity, unit_price, products(name)')
          .in('order_id', orderIds)
      : { data: [] as any[] };

    const total_vendido = pedidosPagos.reduce((s, p) => s + (p.total ?? 0), 0);
    const total_gorjeta = pedidosPagos.reduce((s, p) => s + (p.gorjeta_valor ?? 0), 0);
    const total_comissao = ((comissoes ?? []) as any[]).reduce((s, c) => s + (c.valor_calculado ?? 0), 0);

    // Comandas ainda abertas do garçom (não filtra por intervalo — é o estado atual, igual
    // comandas_abertas do preview de encerramento) — pra dar visibilidade de quanto ainda
    // está "em jogo": total em aberto, e a projeção de gorjeta/comissão SE tudo isso for
    // pago do jeito que está agora (mesmas regras usadas de verdade no fechamento da
    // comanda — ver lancarComissoes/sugestaoGorjeta em salao-pdv.service.ts).
    const comandasAbertas = await this.comandasAbertasDoGarcom(garcomId);
    const total_em_aberto = comandasAbertas.reduce((s, c: any) => s + (c.total ?? 0), 0);

    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('gorjeta_percentual')
      .eq('id', restaurantId)
      .maybeSingle();
    const gorjetaPercentual = (restaurante as any)?.gorjeta_percentual ?? 0;
    const gorjeta_projetada_em_aberto = parseFloat(((total_em_aberto * gorjetaPercentual) / 100).toFixed(2));

    const { data: configsComissao } = await this.supabase.client
      .from('garcom_comissoes_config')
      .select('tipo, valor')
      .eq('restaurant_id', restaurantId)
      .eq('ativo', true);
    let comissao_projetada_em_aberto = 0;
    for (const c of comandasAbertas as any[]) {
      for (const cfg of (configsComissao ?? []) as any[]) {
        comissao_projetada_em_aberto += cfg.tipo === 'percentual' ? ((c.total ?? 0) * cfg.valor) / 100 : cfg.valor;
      }
    }
    comissao_projetada_em_aberto = parseFloat(comissao_projetada_em_aberto.toFixed(2));

    const vendas = pedidosPagos
      .map((p) => ({
        order_id: p.id,
        numero_comanda: p.numero_comanda,
        mesa_numero: p.mesas?.numero ?? null,
        mesa_nome: p.mesas?.nome ?? null,
        cliente_nome: p.cliente_mesa_nome ?? null,
        data: p.created_at,
        total: p.total ?? 0,
        gorjeta: p.gorjeta_valor ?? 0,
      }))
      .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());

    const itens_vendidos = ((itens ?? []) as any[]).map((i) => ({
      order_id: i.order_id,
      product_name: i.products?.name ?? null,
      quantity: i.quantity,
      unit_price: i.unit_price,
    }));

    return {
      total_vendido,
      total_em_aberto,
      total_gorjeta,
      gorjeta_projetada: parseFloat((total_gorjeta + gorjeta_projetada_em_aberto).toFixed(2)),
      total_comissao,
      comissao_projetada: parseFloat((total_comissao + comissao_projetada_em_aberto).toFixed(2)),
      vendas,
      itens_vendidos,
    };
  }

  private async comandasAbertasDoGarcom(garcomId: number) {
    const { data } = await this.supabase.client
      .from('orders')
      .select('id, numero_comanda, mesa_id, cliente_mesa_nome, status, total, mesas(numero, nome)')
      .eq('garcom_id', garcomId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom']);
    return data ?? [];
  }

  async previewEncerramento(garcomId: number, restaurantId: number) {
    const turno = await this.turnoAtivo(garcomId);
    if (!turno) throw new NotFoundException('Nenhuma sessão de trabalho aberta');

    const [resumo, comandas_abertas] = await Promise.all([
      this.resumoTurno(garcomId, restaurantId, turno.aberto_em, new Date().toISOString()),
      this.comandasAbertasDoGarcom(garcomId),
    ]);

    return { turno, resumo, comandas_abertas };
  }

  async encerrarTurno(garcomId: number, restaurantId: number, body: { conferido: boolean; observacao?: string }) {
    const turno = await this.turnoAtivo(garcomId);
    if (!turno) throw new NotFoundException('Nenhuma sessão de trabalho aberta');

    const fechado_em = new Date().toISOString();
    const [resumoFinanceiro, comandas_mantidas_abertas] = await Promise.all([
      this.resumoTurno(garcomId, restaurantId, turno.aberto_em, fechado_em),
      this.comandasAbertasDoGarcom(garcomId),
    ]);

    const resumo = { ...resumoFinanceiro, comandas_mantidas_abertas };

    const { data, error } = await this.supabase.client
      .from('garcom_turnos')
      .update({
        status: 'fechado',
        fechado_em,
        resumo,
        conferido_pelo_garcom: body.conferido,
        observacao_garcom: body.observacao?.trim() || null,
      })
      .eq('id', turno.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async historicoTurnos(garcomId: number, de: string, ate: string) {
    const { data, error } = await this.supabase.client
      .from('garcom_turnos')
      .select('*')
      .eq('garcom_id', garcomId)
      .eq('status', 'fechado')
      .gte('fechado_em', de)
      .lte('fechado_em', ate)
      .order('fechado_em', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }
}

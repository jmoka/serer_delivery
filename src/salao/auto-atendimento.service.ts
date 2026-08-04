import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { SalaoService, ItemComandaBody } from './salao.service';
import { EstoqueService } from '../estoque/estoque.service';
import { CombosService, ItemExpandido } from '../combos/combos.service';

const SESSAO_TTL_MS = 6 * 60 * 60 * 1000; // 6h — renovada a cada ação do cliente na mesa.

// Cliente faz o pedido direto pela mesa via QR, sem depender do garçom (pedido do
// usuário 2026-08-03). Rota totalmente pública (sem login), no mesmo espírito do
// mesa-acompanhar.controller.ts — a única "credencial" é conhecer o token da mesa
// (impresso/exibido fisicamente) + a sessionId emitida na primeira entrada.
//
// Trava "1 cliente por mesa" (pedido explícito do usuário, item 7): a sessão fica
// presa à COMANDA (não à mesa em si) e só libera quando a comanda fecha — igual o
// ciclo de vida natural da mesa. Mesmo padrão de UPDATE condicional usado em
// garcons/motoboys (20260730000001_sessao_unica_garcom_motoboy.sql), só que aqui
// quem "expira" a sessão anterior é o fechamento da comanda, não um timer.
@Injectable()
export class AutoAtendimentoService {
  constructor(
    private supabase: SupabaseService,
    private estoque: EstoqueService,
    private combosService: CombosService,
    private salaoService: SalaoService,
  ) {}

  private async resolverMesa(mesaToken: string) {
    const { data: mesa } = await this.supabase.client
      .from('mesas')
      .select('id, restaurant_id, status, numero, nome, restaurants(slug, name, auto_atendimento_habilitado, aparencia, gorjeta_percentual)')
      .eq('auto_atendimento_token', mesaToken)
      .maybeSingle();
    if (!mesa) throw new NotFoundException('Mesa não encontrada');

    const restaurante = (mesa as any).restaurants;
    if (!restaurante?.auto_atendimento_habilitado) {
      throw new ForbiddenException('Auto atendimento não está disponível nesse estabelecimento.');
    }
    if (restaurante?.aparencia?.aberto !== true) {
      throw new ForbiddenException('Restaurante fechado no momento.');
    }
    return mesa as any;
  }

  private async comandaAbertaDaMesa(mesaId: number) {
    const { data } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, numero_comanda, sem_gorjeta, desconto_valor, acrescimo_valor, gorjeta_valor, conferencia_solicitada_em, cliente_session_id, cliente_session_expires_at, mesas(numero, nome)')
      .eq('mesa_id', mesaId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .maybeSingle();
    return data as any;
  }

  private sessaoValida(comanda: any, sessionId: string) {
    return (
      !!comanda.cliente_session_id &&
      comanda.cliente_session_id === sessionId &&
      !!comanda.cliente_session_expires_at &&
      new Date(comanda.cliente_session_expires_at).getTime() > Date.now()
    );
  }

  private async garantirComandaDoCliente(mesaToken: string, sessionId: string) {
    if (!sessionId) throw new ForbiddenException('Sessão inválida — escaneie o QR da mesa novamente.');
    const mesa = await this.resolverMesa(mesaToken);
    const comanda = await this.comandaAbertaDaMesa(mesa.id);
    if (!comanda) throw new NotFoundException('Nenhum atendimento em andamento nessa mesa — escaneie o QR de novo.');
    if (!this.sessaoValida(comanda, sessionId)) {
      throw new ForbiddenException('Sessão encerrada — escaneie o QR da mesa de novo.');
    }
    comanda.restauranteSlug = mesa.restaurants?.slug ?? null;
    comanda.gorjetaPercentual = mesa.restaurants?.gorjeta_percentual ?? 0;
    return comanda;
  }

  // Cliente NUNCA abre a mesa sozinho — só o garçom/dono abre a comanda (fluxo normal
  // de sempre, intocado). O QR fixo da mesa é só um jeito de o cliente ENTRAR na
  // comanda que já está aberta. Se não tiver nenhuma comanda aberta ainda, retorna
  // um estado (não é erro) pro front mostrar "aguarde o garçom te atender".
  //
  // Trava do item 7: primeiro celular que escanear reivindica a sessão daquela
  // comanda (UPDATE condicional, só passa se cliente_session_id ainda for null) —
  // isso deixa o cliente legítimo (quem o garçom sentou) entrar normalmente, mas
  // barra alguém com uma foto do QR tentando mexer na comanda de outra mesa depois.
  async entrar(mesaToken: string) {
    const mesa = await this.resolverMesa(mesaToken);
    const comanda = await this.comandaAbertaDaMesa(mesa.id);
    if (!comanda) {
      return { aguardandoGarcom: true, mesa: { numero: mesa.numero, nome: mesa.nome } };
    }
    if (comanda.cliente_session_id) {
      throw new ForbiddenException('Essa mesa já está em atendimento pelo celular de outro cliente.');
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSAO_TTL_MS).toISOString();
    const { data: claimed, error } = await this.supabase.client
      .from('orders')
      .update({ cliente_session_id: sessionId, cliente_session_expires_at: expiresAt })
      .eq('id', comanda.id)
      .is('cliente_session_id', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!claimed) {
      throw new ForbiddenException('Essa mesa já está em atendimento pelo celular de outro cliente.');
    }

    return {
      comandaId: comanda.id,
      sessionId,
      restauranteSlug: (mesa as any).restaurants?.slug ?? null,
      mesa: { numero: mesa.numero, nome: mesa.nome },
    };
  }

  // Renova a validade da sessão a cada ação — cliente não some no meio do jantar
  // só porque passou o TTL inicial de 6h.
  private async renovarSessao(comandaId: number, sessionId: string) {
    await this.supabase.client
      .from('orders')
      .update({ cliente_session_expires_at: new Date(Date.now() + SESSAO_TTL_MS).toISOString() })
      .eq('id', comandaId)
      .eq('cliente_session_id', sessionId);
  }

  // Resumo financeiro completo (subtotal, desconto, acréscimo, gorjeta, taxa de
  // cartão, total, saldo devedor, pagamentos parciais) — mesma fórmula usada em
  // acompanharPorToken (mesa-acompanhar), pra o cliente ver a conta real, não só
  // o carrinho ainda não enviado. Pedido do usuário 2026-08-03: não pode faltar
  // nenhuma dessas informações na tela do auto atendimento.
  async obterComanda(mesaToken: string, sessionId: string) {
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);
    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, observacao, combo_nome, status, enviado_em, preparando_em, pronto_em, products(name, image_url)')
      .eq('order_id', comanda.id)
      .order('id', { ascending: true });

    const saldo = await this.salaoService.saldoDevedor(comanda.id);
    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, criado_em, taxa_cartao_valor')
      .eq('order_id', comanda.id)
      .order('criado_em', { ascending: true });
    const taxaCartaoTotal = (pagamentos ?? []).reduce((acc: number, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);

    const percentualGorjeta = comanda.gorjetaPercentual ?? 0;
    const gorjetaJaDefinida = comanda.gorjeta_valor !== null && comanda.gorjeta_valor !== undefined;
    const gorjetaEstimativa = !gorjetaJaDefinida && comanda.status !== 'paga' && percentualGorjeta > 0 && !comanda.sem_gorjeta;
    let gorjetaValor = comanda.sem_gorjeta ? 0 : (comanda.gorjeta_valor ?? 0);
    let totalComGorjeta = saldo.total;
    let saldoComGorjeta = saldo.saldo;
    if (gorjetaEstimativa) {
      const baseCalculo = saldo.subtotal - (comanda.desconto_valor ?? 0) + (comanda.acrescimo_valor ?? 0);
      gorjetaValor = parseFloat(((baseCalculo * percentualGorjeta) / 100).toFixed(2));
      totalComGorjeta = parseFloat((saldo.total + gorjetaValor).toFixed(2));
      saldoComGorjeta = parseFloat((saldo.saldo + gorjetaValor).toFixed(2));
    }

    return {
      comandaId: comanda.id,
      status: comanda.status,
      restauranteSlug: comanda.restauranteSlug,
      numeroComanda: comanda.numero_comanda,
      conferenciaSolicitadaEm: comanda.conferencia_solicitada_em,
      semGorjeta: comanda.sem_gorjeta ?? false,
      gorjetaPercentual: percentualGorjeta,
      mesa: comanda.mesas ? { numero: comanda.mesas.numero, nome: comanda.mesas.nome } : null,
      itens: itens ?? [],
      subtotal: saldo.subtotal,
      desconto: comanda.desconto_valor ?? 0,
      acrescimo: comanda.acrescimo_valor ?? 0,
      gorjeta: gorjetaValor,
      gorjetaEstimativa,
      taxaCartaoTotal: parseFloat(taxaCartaoTotal.toFixed(2)),
      total: totalComGorjeta,
      totalPago: saldo.total_pago,
      saldo: saldoComGorjeta,
      pagamentos: (pagamentos ?? []).map((p: any) => ({
        valor: p.valor,
        forma_pagamento: p.forma_pagamento,
        criado_em: p.criado_em,
        taxa_cartao_valor: p.taxa_cartao_valor ?? 0,
      })),
    };
  }

  // Cliente escolhe se paga a gorjeta do garçom (marcado por padrão quando o restaurante
  // cobra gorjeta) — persiste em orders.sem_gorjeta pro garçom/caixa respeitar no
  // fechamento (o checkbox que já existia lá era só estado local, nunca salvava nada).
  async definirGorjeta(mesaToken: string, sessionId: string, semGorjeta: boolean) {
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);
    const { error } = await this.supabase.client.from('orders').update({ sem_gorjeta: semGorjeta }).eq('id', comanda.id);
    if (error) throw error;
    await this.renovarSessao(comanda.id, sessionId);
    return this.obterComanda(mesaToken, sessionId);
  }

  // Mesma lógica de inserção do garçom/PDV (produto direto ou combo expandido) —
  // item sempre entra 'pendente', só vai pra fila quando o cliente confirmar em
  // "Solicitar pedido" (solicitarPedido abaixo), igual o fluxo do garçom.
  async adicionarItens(mesaToken: string, sessionId: string, itens: ItemComandaBody[]) {
    if (!itens?.length) throw new BadRequestException('Informe ao menos 1 item');
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);
    if (comanda.status !== 'aberta') throw new BadRequestException('Comanda não está mais aberta');

    const itensDiretos = itens.filter((i) => i.product_id != null);
    const itensCombo = itens.filter((i) => i.combo_id != null);

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
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} indisponível`);
    }

    const linhasCombo = (
      await Promise.all(
        itensCombo.map(async (i) => {
          const linhas = await this.combosService.expandir(i.combo_id as number, i.quantity, comanda.restaurant_id);
          return linhas.map((l) => ({ ...l, observacao: i.observacao }));
        }),
      )
    ).flat();

    const linhasDiretas: (ItemExpandido & { observacao?: string })[] = itensDiretos.map((i) => ({
      product_id: i.product_id as number,
      quantity: i.quantity,
      unit_price: prodMap[i.product_id as number].price,
      observacao: i.observacao,
    }));

    const linhasFinais = [...linhasDiretas, ...linhasCombo];

    const { error } = await this.supabase.client.from('order_items').insert(
      linhasFinais.map((l) => ({
        order_id: comanda.id,
        product_id: l.product_id,
        quantity: l.quantity,
        unit_price: l.unit_price,
        observacao: l.observacao?.trim() || null,
        combo_nome: l.combo_nome ?? null,
        combo_quantidade: l.combo_quantidade ?? null,
        status: 'pendente',
      })),
    );
    if (error) throw error;

    await this.estoque.decrementarItens(linhasFinais);

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comanda.id);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', comanda.id);

    await this.renovarSessao(comanda.id, sessionId);
    return this.obterComanda(mesaToken, sessionId);
  }

  // Cliente pode remover um item do carrinho antes de "Solicitar pedido" — só item
  // ainda 'pendente' (mesma regra do garçom), depois de enviado só o estabelecimento mexe.
  async removerItem(mesaToken: string, sessionId: string, itemId: number) {
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, status, product_id, quantity')
      .eq('id', itemId)
      .eq('order_id', comanda.id)
      .maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.status !== 'pendente') throw new ForbiddenException('Item já foi enviado — não é mais possível remover');

    const { error } = await this.supabase.client.from('order_items').delete().eq('id', itemId);
    if (error) throw error;

    await this.estoque.restaurarItens([{ product_id: item.product_id, quantity: item.quantity }]);

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comanda.id);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', comanda.id);

    await this.renovarSessao(comanda.id, sessionId);
    return this.obterComanda(mesaToken, sessionId);
  }

  // "Solicitar pedido" — manda tudo que está pendente direto pra fila de preparo
  // (mesmo processarEnvioPendentes do garçom/PDV), sem etapa de aprovação intermediária.
  // Também marca ultimo_pedido_cliente_em pro garçom responsável pela mesa receber um
  // alerta (pedido do usuário 2026-08-03) — se a comanda não tiver garçom (aberta
  // direto pelo dono/caixa), ninguém é notificado, mas os itens seguem normal pro
  // setor/impressora de sempre.
  async solicitarPedido(mesaToken: string, sessionId: string) {
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);
    await this.salaoService.enviarItensComoRestaurante(comanda.id, comanda);
    await this.supabase.client
      .from('orders')
      .update({ ultimo_pedido_cliente_em: new Date().toISOString() })
      .eq('id', comanda.id);
    await this.renovarSessao(comanda.id, sessionId);
    return this.obterComanda(mesaToken, sessionId);
  }

  // Cliente chama o garçom/caixa pra fechar a conta — mesmo campo que o mesa-acompanhar
  // (tracking_token) já usa, só que autenticado pela sessão do auto atendimento em vez
  // do token de leitura. Idempotente: só marca a primeira vez, até o caixa atender.
  async solicitarConferencia(mesaToken: string, sessionId: string) {
    const comanda = await this.garantirComandaDoCliente(mesaToken, sessionId);
    await this.supabase.client
      .from('orders')
      .update({ conferencia_solicitada_em: new Date().toISOString() })
      .eq('id', comanda.id)
      .is('conferencia_solicitada_em', null);
    await this.renovarSessao(comanda.id, sessionId);
    return this.obterComanda(mesaToken, sessionId);
  }
}

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
      .select('id, mesa_id, garcom_id, total, status, numero_comanda, cliente_mesa_nome, garcons(nome), aberto_por_nome')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .not('mesa_id', 'is', null);

    const comandaPorMesa = new Map((comandas ?? []).map((c: any) => [c.mesa_id, c]));

    return (mesas ?? []).map((m: any) => ({ ...m, comanda: comandaPorMesa.get(m.id) ?? null }));
  }

  // Bloqueia uma mesa livre (reserva, manutenção...) — fica indisponível pro garçom
  // até ser desbloqueada, sem precisar de comanda aberta nela.
  async bloquearMesa(mesaId: number, restaurantId: number) {
    const { data: mesa } = await this.supabase.client
      .from('mesas').select('id, status').eq('id', mesaId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!mesa) throw new NotFoundException('Mesa não encontrada');
    if (mesa.status !== 'livre') throw new BadRequestException('Só é possível bloquear uma mesa livre');

    const { error } = await this.supabase.client.from('mesas').update({ status: 'bloqueada' }).eq('id', mesaId);
    if (error) throw error;
    return { ok: true };
  }

  async desbloquearMesa(mesaId: number, restaurantId: number) {
    const { data: mesa } = await this.supabase.client
      .from('mesas').select('id, status').eq('id', mesaId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!mesa) throw new NotFoundException('Mesa não encontrada');
    if (mesa.status !== 'bloqueada') throw new BadRequestException('Mesa não está bloqueada');

    const { error } = await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', mesaId);
    if (error) throw error;
    return { ok: true };
  }

  // Estabelecimento abre mesa/comanda direto (sem garçom envolvido) — mesma regra de
  // salao_modo e obrigatoriedade de nome/telefone do cliente do lado do garçom.
  // Guarda o primeiro nome de quem tava logado (aberto_por_nome) pro card da mesa
  // mostrar "Caixa: nome" pro garçom e pro próprio estabelecimento.
  async abrirComanda(restaurantId: number, userId: string, body: { mesa_id?: number; cliente_nome: string; cliente_telefone: string }) {
    if (!body.cliente_nome || !body.cliente_telefone) {
      throw new BadRequestException('Nome e telefone do cliente são obrigatórios');
    }

    const { data: restaurante } = await this.supabase.client
      .from('restaurants').select('salao_modo').eq('id', restaurantId).maybeSingle();
    const salaoModo = (restaurante as any)?.salao_modo ?? 'ambos';
    if (salaoModo === 'mesas' && !body.mesa_id) {
      throw new BadRequestException('Este restaurante só trabalha com mesas — selecione uma mesa');
    }
    if (salaoModo === 'comandas' && body.mesa_id) {
      throw new BadRequestException('Este restaurante só trabalha com comandas avulsas — não vincule a uma mesa');
    }

    let mesa: { id: number } | null = null;
    if (body.mesa_id) {
      const { data } = await this.supabase.client
        .from('mesas').select('id, status').eq('id', body.mesa_id).eq('restaurant_id', restaurantId).maybeSingle();
      if (!data) throw new NotFoundException('Mesa não encontrada');
      if (data.status !== 'livre') throw new BadRequestException('Mesa não está livre');
      mesa = data;
    }

    const { data: caixaAberto } = await this.supabase.client
      .from('caixas').select('id').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();

    const { data: userData } = await this.supabase.client.auth.admin.getUserById(userId);
    const nomeCompleto = userData?.user?.user_metadata?.name as string | undefined;
    const abertoPorNome = nomeCompleto?.trim().split(' ')[0] || null;

    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);
    const { count } = await this.supabase.client
      .from('orders').select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId).eq('canal', 'presencial').gte('created_at', inicioDoDia.toISOString());
    const numeroComanda = (count ?? 0) + 1;

    const { data: comanda, error } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        canal: 'presencial',
        status: 'aberta',
        mesa_id: mesa?.id ?? null,
        cliente_mesa_nome: body.cliente_nome,
        cliente_mesa_telefone: body.cliente_telefone,
        total: 0,
        caixa_id: caixaAberto?.id ?? null,
        numero_comanda: numeroComanda,
        aberto_por_nome: abertoPorNome,
      })
      .select('id')
      .single();
    if (error) throw error;

    if (mesa) {
      await this.supabase.client.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id);
    }

    return this.comandaDetalhe(comanda.id, restaurantId);
  }

  async comandasAbertas(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, total, status, payment_method, numero_comanda, created_at, mesas(numero, nome), garcons(nome), aberto_por_nome')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  // Cliente às vezes pede a comanda de novo pra conferência depois de já ter pago —
  // lista as fechadas hoje (paga), pra abrir no modal em modo leitura e reimprimir.
  // Filtra por pago_em (data real do pagamento), não created_at — uma comanda aberta
  // ontem e paga hoje precisa aparecer aqui, senão some das duas listas (aberta já não
  // é mais, fechada-hoje não entrava por causa da data de abertura).
  async comandasFechadasHoje(restaurantId: number) {
    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, total, gorjeta_valor, status, payment_method, numero_comanda, created_at, pago_em, mesas(numero, nome), garcons(nome), aberto_por_nome')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .eq('status', 'paga')
      // Pedidos antigos (antes dessa coluna existir) não têm pago_em — cai no fallback por created_at.
      .or(`pago_em.gte.${inicioDoDia.toISOString()},and(pago_em.is.null,created_at.gte.${inicioDoDia.toISOString()})`)
      .order('pago_em', { ascending: false, nullsFirst: false })
      .limit(50);
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
    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, valor, forma_pagamento, origem, criado_em, taxa_cartao_valor')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });
    const saldo = await this.salaoService.saldoDevedor(id);
    return { ...comanda, itens, pagamentos: pagamentos ?? [], saldo };
  }

  // Pagamento parcial registrado pelo caixa — mesma regra do garçom (não fecha sozinho).
  async registrarPagamentoParcial(id: number, restaurantId: number, valor: number, formaPagamento: string, valorRecebido?: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }
    const identificador = `Comanda #${comanda.numero_comanda ?? id}`;
    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valor, formaPagamento);
    return this.salaoService.registrarPagamento(id, 'estabelecimento', valor, formaPagamento, restaurantId, valorRecebido, identificador, taxaCartaoValor);
  }

  private async buscarPagamento(comandaId: number, pagamentoId: number) {
    const { data } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id')
      .eq('id', pagamentoId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Pagamento não encontrado');
  }

  // Comanda já paga só pode ter a forma de pagamento corrigida (não valor) enquanto o
  // caixa dela ainda está aberto — o resumo do caixa é recalculado do zero a cada
  // fechamento (ver calcularResumo em restaurante.service.ts), então a correção reflete
  // automaticamente. Se o caixa já fechou, o resumo daquele fechamento já foi gravado e
  // congelado — corrigir aqui não atualizaria retroativamente, então bloqueia.
  private async garantirCaixaAbertoDaComanda(comanda: any) {
    if (!comanda.caixa_id) return;
    const { data: caixa } = await this.supabase.client
      .from('caixas').select('status').eq('id', comanda.caixa_id).maybeSingle();
    if (caixa && caixa.status !== 'aberto') {
      throw new BadRequestException('O caixa desta comanda já foi fechado — não é possível corrigir o pagamento automaticamente. Ajuste manualmente o fechamento desse caixa se necessário.');
    }
  }

  // Caixa edita/remove qualquer pagamento da comanda (origem garçom ou estabelecimento).
  // O garçom também pode editar/remover, mas só o que ele mesmo lançou — ver
  // editarPagamentoComoGarcom/removerPagamentoComoGarcom em salao.service.ts.
  // Comanda paga: só a forma de pagamento pode mudar (ex: confirmou PIX por engano, era
  // dinheiro) — valor fica travado pra não reabrir saldo devedor de uma venda já fechada.
  async editarPagamentoParcial(comandaId: number, restaurantId: number, pagamentoId: number, valor: number, formaPagamento: string) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom', 'paga'].includes(comanda.status)) {
      throw new BadRequestException('Comanda cancelada — não é possível editar o pagamento');
    }
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    if (comanda.status === 'paga') {
      await this.garantirCaixaAbertoDaComanda(comanda);
      await this.buscarPagamento(comandaId, pagamentoId);
      const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valor, formaPagamento);
      const { error } = await this.supabase.client
        .from('comanda_pagamentos')
        .update({ forma_pagamento: formaPagamento, taxa_cartao_valor: taxaCartaoValor || null })
        .eq('id', pagamentoId);
      if (error) throw error;
      // orders.payment_method só é usado como resumo de exibição quando não há
      // comanda_pagamentos — mantém em sincronia mesmo assim, evita confusão no recibo.
      await this.supabase.client.from('orders').update({ payment_method: formaPagamento }).eq('id', comandaId);
      return this.comandaDetalhe(comandaId, restaurantId);
    }

    if (!valor || valor <= 0) throw new BadRequestException('Valor precisa ser maior que zero');
    await this.buscarPagamento(comandaId, pagamentoId);

    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valor, formaPagamento);
    const { error } = await this.supabase.client
      .from('comanda_pagamentos')
      .update({ valor, forma_pagamento: formaPagamento, taxa_cartao_valor: taxaCartaoValor || null })
      .eq('id', pagamentoId);
    if (error) throw error;

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  async removerPagamentoParcial(comandaId: number, restaurantId: number, pagamentoId: number) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    await this.buscarPagamento(comandaId, pagamentoId);

    const { error } = await this.supabase.client.from('comanda_pagamentos').delete().eq('id', pagamentoId);
    if (error) throw error;

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  // Venda direta no balcão: operador escolhe produtos, paga na hora, sem mesa/garçom/
  // cliente prévios. Itens ainda passam pela fila de preparo normal (cozinha/bar) —
  // só o fluxo de venda/pagamento é imediato, não o preparo.
  async vendaDireta(restaurantId: number, itens: ItemComandaBody[], formaPagamento: string, valorRecebido?: number) {
    if (!itens?.length) throw new BadRequestException('Informe ao menos 1 item');
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    const prodIds = itens.map((i) => i.product_id);
    const { data: produtos, error: errProd } = await this.supabase.client
      .from('products').select('id, name, price, is_active').in('id', prodIds);
    if (errProd) throw errProd;

    const prodMap = Object.fromEntries((produtos ?? []).map((p: any) => [p.id, p]));
    for (const item of itens) {
      const prod = prodMap[item.product_id];
      if (!prod) throw new BadRequestException(`Produto ${item.product_id} não encontrado`);
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} inativo`);
    }
    const total = itens.reduce((acc, i) => acc + i.quantity * prodMap[i.product_id].price, 0);

    const { data: caixaAberto } = await this.supabase.client
      .from('caixas').select('id').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();
    if (!caixaAberto) throw new BadRequestException('Abra o caixa antes de vender');

    const { data: venda, error } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        canal: 'presencial',
        status: 'aberta',
        cliente_mesa_nome: 'Venda balcão',
        total: parseFloat(total.toFixed(2)),
        caixa_id: caixaAberto.id,
      })
      .select('*, mesas(numero, nome), garcons(id, nome)')
      .single();
    if (error) throw error;

    const { error: errItens } = await this.supabase.client.from('order_items').insert(
      itens.map((i) => ({
        order_id: venda.id,
        product_id: i.product_id,
        quantity: i.quantity,
        unit_price: prodMap[i.product_id].price,
        observacao: i.observacao?.trim() || null,
        status: 'pendente',
      })),
    );
    if (errItens) throw errItens;

    // Manda pra fila de preparo (cozinha/bar), igual uma comanda normal
    await this.salaoService.enviarItensComoRestaurante(venda.id, venda);

    // Paga na hora — origem 'estabelecimento' cobre troco/gorjeta automaticamente
    await this.salaoService.registrarPagamento(venda.id, 'estabelecimento', total, formaPagamento, restaurantId, valorRecebido, 'Venda balcão');

    const { error: errFechar } = await this.supabase.client
      .from('orders')
      .update({ status: 'paga', payment_method: formaPagamento, pago_em: new Date().toISOString() })
      .eq('id', venda.id);
    if (errFechar) throw errFechar;

    const trocoDado = formaPagamento === 'cash' && valorRecebido !== undefined ? Math.max(valorRecebido - total, 0) : 0;
    const recibo = await this.salaoService.imprimirReciboSeConfigurado(
      restaurantId, venda,
      itens.map((i) => ({ product_name: prodMap[i.product_id]?.name, quantity: i.quantity, unit_price: prodMap[i.product_id]?.price })),
      { subtotal: total, total, formaPagamento, trocoDado },
    );

    const detalhe = await this.comandaDetalhe(venda.id, restaurantId);
    return { ...detalhe, recibo };
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

  // Estabelecimento pode remover qualquer item (pendente ou já enviado) — diferente do
  // garçom, que só mexe em item ainda não enviado (ver salao.service.ts).
  // Estabelecimento pode editar qualquer item (pendente ou já enviado) — diferente do
  // garçom, que só mexe em item ainda não enviado (ver salao.service.ts).
  async editarItem(comandaId: number, restaurantId: number, itemId: number, body: { quantity?: number; observacao?: string }) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: item } = await this.supabase.client
      .from('order_items').select('id').eq('id', itemId).eq('order_id', comandaId).maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const update: Record<string, unknown> = {};
    if (body.quantity !== undefined) {
      if (body.quantity < 1) throw new BadRequestException('Quantidade mínima é 1');
      update.quantity = body.quantity;
    }
    if (body.observacao !== undefined) update.observacao = body.observacao?.trim() || null;

    const { error } = await this.supabase.client.from('order_items').update(update).eq('id', itemId);
    if (error) throw error;

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comandaId);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', comandaId);

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  async removerItem(comandaId: number, restaurantId: number, itemId: number) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id')
      .eq('id', itemId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const { error } = await this.supabase.client.from('order_items').delete().eq('id', itemId);
    if (error) throw error;

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comandaId);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', comandaId);

    return this.comandaDetalhe(comandaId, restaurantId);
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

  // Transfere/junta uma comanda em andamento — dois casos:
  // 1) mesa_id de destino livre: só move a comanda pra essa mesa (troca física simples).
  // 2) mesa_id de destino ocupada, ou comanda_destino_id direto: junta tudo (itens +
  //    pagamentos parciais já registrados) na comanda de destino e encerra a origem.
  async transferir(origemId: number, restaurantId: number, params: { mesa_id?: number; comanda_destino_id?: number }) {
    const origem = await this.buscarComanda(origemId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(origem.status)) {
      throw new BadRequestException('Só é possível transferir comandas abertas ou aguardando pagamento');
    }

    let destinoId = params.comanda_destino_id ?? null;

    if (params.mesa_id) {
      const { data: mesaDestino } = await this.supabase.client
        .from('mesas')
        .select('id, status')
        .eq('id', params.mesa_id)
        .eq('restaurant_id', restaurantId)
        .maybeSingle();
      if (!mesaDestino) throw new NotFoundException('Mesa de destino não encontrada');

      if (mesaDestino.status === 'livre') {
        // Caso simples: só move a comanda pra mesa nova, sem juntar nada.
        const { error } = await this.supabase.client.from('orders').update({ mesa_id: mesaDestino.id }).eq('id', origemId);
        if (error) throw error;
        await this.supabase.client.from('mesas').update({ status: 'ocupada' }).eq('id', mesaDestino.id);
        if (origem.mesa_id) {
          await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', origem.mesa_id);
        }
        return { ok: true, modo: 'movida' };
      }

      // Mesa de destino ocupada — precisa achar a comanda dela pra juntar.
      const { data: comandaNaMesa } = await this.supabase.client
        .from('orders')
        .select('id')
        .eq('mesa_id', mesaDestino.id)
        .eq('restaurant_id', restaurantId)
        .eq('canal', 'presencial')
        .in('status', ['aberta', 'fechada_garcom'])
        .maybeSingle();
      if (!comandaNaMesa) throw new BadRequestException('Mesa de destino não tem comanda aberta pra juntar');
      destinoId = comandaNaMesa.id;
    }

    if (!destinoId) throw new BadRequestException('Informe uma mesa de destino ou uma comanda de destino');
    if (destinoId === origemId) throw new BadRequestException('Comanda de destino não pode ser a mesma da origem');

    const destino = await this.buscarComanda(destinoId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(destino.status)) {
      throw new BadRequestException('Comanda de destino não está aberta');
    }

    // Junta: itens e pagamentos da origem passam a pertencer à comanda de destino.
    const { error: errItens } = await this.supabase.client.from('order_items').update({ order_id: destinoId }).eq('order_id', origemId);
    if (errItens) throw errItens;

    const { error: errPagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .update({ order_id: destinoId })
      .eq('order_id', origemId);
    if (errPagamentos) throw errPagamentos;

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', destinoId);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', destinoId);

    // Origem encerra sem itens — marcada como cancelada pra não sobrar comanda fantasma
    // nem duplicar nos relatórios (os itens/pagamentos já estão todos no destino agora).
    await this.supabase.client.from('orders').update({ status: 'canceled' }).eq('id', origemId);
    if (origem.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', origem.mesa_id);
    }

    return { ok: true, modo: 'juntada', comanda_destino_id: destinoId };
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

  // Caixa pede a conferência antes de fechar — mesma lógica de impressão do QR do cliente
  // (mesa-acompanhar), mas autenticada pelo dono e sem depender do tracking_token.
  async imprimirConferencia(
    id: number,
    restaurantId: number,
    valores: { desconto?: number; acrescimo?: number; gorjeta?: number; taxaCartao?: number; formaPagamento?: string } = {},
  ): Promise<{ ok: true; via: 'agente' | 'navegador' }> {
    const comanda = await this.buscarComanda(id, restaurantId);

    // Caixa atendeu a conferência agora — limpa o pedido do cliente (se houver) pra
    // sumir o aviso na tela do garçom/mesas.
    await this.supabase.client.from('orders').update({ conferencia_solicitada_em: null }).eq('id', id);

    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('name, recibo_impressora_id')
      .eq('id', restaurantId)
      .maybeSingle();

    const impressoraId = restaurante?.recibo_impressora_id;
    if (!impressoraId) return { ok: true, via: 'navegador' };

    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, nome_sistema')
      .eq('id', impressoraId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!impressora?.nome_sistema) return { ok: true, via: 'navegador' };

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('quantity, products(name, price)')
      .eq('order_id', id);

    const itensFormatados = (itens ?? []).map((i: any) => ({
      product_name: i.products?.name,
      quantity: i.quantity,
      unit_price: i.products?.price,
    }));

    const conteudo = this.salaoService.formatarConferenciaTexto(restaurante?.name, comanda, itensFormatados, valores);
    const { error } = await this.supabase.client.from('impressao_jobs').insert({
      restaurant_id: restaurantId,
      impressora_id: impressoraId,
      conteudo,
    });
    if (error) throw error;
    return { ok: true, via: 'agente' };
  }

  // Cliente pediu pra continuar consumindo depois de já ter fechado a conta —
  // volta a comanda pro garçom (status aberta) e destrava a mesa pra atendimento normal.
  async reabrir(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (comanda.status !== 'fechada_garcom') {
      throw new BadRequestException('Só é possível reabrir comandas aguardando pagamento');
    }

    const { error } = await this.supabase.client.from('orders').update({ status: 'aberta' }).eq('id', id);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'ocupada' }).eq('id', comanda.mesa_id);
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

  async pagar(id: number, restaurantId: number, formaPagamento: string, gorjetaValor?: number, valorRecebido?: number) {
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    const comanda = await this.buscarComanda(id, restaurantId);
    if (comanda.status !== 'fechada_garcom' && comanda.status !== 'aberta') {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price, products(name)').eq('order_id', id);
    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const totalFinal = subtotal - (comanda.desconto_valor ?? 0) + (comanda.acrescimo_valor ?? 0);

    // Se já teve pagamento parcial (garçom ou caixa), só registra o que ainda falta —
    // o ledger de comanda_pagamentos fica completo pra conferência.
    const { saldo } = await this.salaoService.saldoDevedor(id);
    const gorjeta = gorjetaValor ?? 0;
    const valorACobrarBase = parseFloat((saldo + gorjeta).toFixed(2));
    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valorACobrarBase, formaPagamento);
    // Em dinheiro, o cliente entrega pro que falta da comanda + gorjeta juntos nesse momento.
    const valorACobrar = parseFloat((valorACobrarBase + taxaCartaoValor).toFixed(2));
    let troco: number | null = null;
    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      if (valorRecebido < valorACobrar) throw new BadRequestException('Valor recebido não pode ser menor que o valor a pagar');
      troco = parseFloat((valorRecebido - valorACobrar).toFixed(2));
    }

    if (saldo > 0.01) {
      await this.salaoService.registrarPagamento(id, 'estabelecimento', saldo, formaPagamento, restaurantId, undefined, undefined, taxaCartaoValor);
    }

    if (formaPagamento === 'cash') {
      const identificador = `Comanda #${comanda.numero_comanda ?? id}`;
      if (gorjeta > 0) await this.salaoService.registrarSaidaCaixa(restaurantId, `Gorjeta - ${identificador}`, gorjeta, 'gorjeta');
      if (troco && troco > 0) await this.salaoService.registrarSaidaCaixa(restaurantId, `Troco - ${identificador}`, troco, 'troco');
    }

    // Se a comanda ficou pendente (fiado) num caixa que já fechou, realoca pro caixa
    // que estiver aberto agora, no momento do pagamento — não fica presa a um caixa fechado.
    let caixaId = comanda.caixa_id;
    if (caixaId) {
      const { data: caixaAtual } = await this.supabase.client
        .from('caixas').select('status').eq('id', caixaId).maybeSingle();
      if (caixaAtual?.status !== 'aberto') caixaId = null;
    }
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
        pago_em: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', comanda.mesa_id);
    }

    await this.lancarComissoes(comanda, subtotal, totalFinal);

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, origem')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });

    const recibo = await this.salaoService.imprimirReciboSeConfigurado(
      restaurantId, comanda,
      (itens ?? []).map((i: any) => ({ product_name: i.products?.name, quantity: i.quantity, unit_price: i.unit_price })),
      {
        subtotal,
        desconto: comanda.desconto_valor ?? 0,
        acrescimo: comanda.acrescimo_valor ?? 0,
        gorjeta,
        taxaCartao: taxaCartaoValor,
        total: parseFloat(totalFinal.toFixed(2)),
        formaPagamento,
        trocoDado: troco && troco > 0 ? troco : 0,
      },
      pagamentos ?? [],
    );

    return {
      ok: true, total: parseFloat(totalFinal.toFixed(2)),
      taxa_cartao_valor: taxaCartaoValor, valor_cobrado: valorACobrar,
      troco, recibo, pagamentos: pagamentos ?? [],
    };
  }

  // Cliente pede a comanda de novo pra conferência mesmo já tendo pago — reimprime o
  // mesmo recibo (mesma lógica de agente/navegador do pagamento original).
  async reimprimirRecibo(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (comanda.status !== 'paga') throw new BadRequestException('Só é possível reimprimir recibo de comanda já paga');

    const { data: itens } = await this.supabase.client
      .from('order_items').select('quantity, unit_price, products(name)').eq('order_id', id);
    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, origem, taxa_cartao_valor')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });

    const taxaCartaoValor = (pagamentos ?? []).reduce((acc: number, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);

    const recibo = await this.salaoService.imprimirReciboSeConfigurado(
      restaurantId, comanda,
      (itens ?? []).map((i: any) => ({ product_name: i.products?.name, quantity: i.quantity, unit_price: i.unit_price })),
      {
        subtotal,
        desconto: comanda.desconto_valor ?? 0,
        acrescimo: comanda.acrescimo_valor ?? 0,
        gorjeta: comanda.gorjeta_valor ?? 0,
        taxaCartao: taxaCartaoValor,
        total: comanda.total,
        formaPagamento: comanda.payment_method,
        trocoDado: 0,
      },
      pagamentos ?? [],
    );

    return { ok: true, recibo, subtotal, taxa_cartao_valor: taxaCartaoValor, pagamentos: pagamentos ?? [] };
  }
}

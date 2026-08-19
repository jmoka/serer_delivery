import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SalaoService } from './salao.service';
import type { ItemComandaBody } from './salao.service';
import { EstoqueService } from '../estoque/estoque.service';
import { CombosService, ItemExpandido } from '../combos/combos.service';

// PDV do caixa (lado estabelecimento): ações de cancelar/desconto/acréscimo/pagar
// são exclusivas do dono (RestaurantOwnerGuard) — o garçom nunca tem acesso a
// essas rotas (ver salao.controller.ts, que só cobre abrir/adicionar/enviar/fechar).
@Injectable()
export class SalaoPdvService {
  constructor(
    private supabase: SupabaseService,
    private salaoService: SalaoService,
    private estoque: EstoqueService,
    private combos: CombosService,
  ) {}

  async mesas(restaurantId: number) {
    const { data: mesas, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status, auto_atendimento_token')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;

    const { data: comandas } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, garcom_id, total, status, numero_comanda, cliente_mesa_nome, garcons(nome), aberto_por_nome, conferencia_solicitada_em')
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

    const numeroComanda = await this.proximoNumeroComanda(restaurantId);

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

  // Numeração diária compartilhada por mesa/comanda avulsa e venda balcão — mesmo
  // contador (ver abrirComanda e abrirVendaBalcao), pra todo ticket impresso ter um
  // número único no dia e poder ser buscado pelo código de barras da comanda.
  private async proximoNumeroComanda(restaurantId: number): Promise<number> {
    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);
    const { count } = await this.supabase.client
      .from('orders').select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId).eq('canal', 'presencial').gte('created_at', inicioDoDia.toISOString());
    return (count ?? 0) + 1;
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
      .select('*, mesas(numero, nome, auto_atendimento_token), garcons(id, nome)')
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
      .select('id, product_id, quantity, unit_price, observacao, combo_nome, combo_quantidade, status, enviado_em, entregue_garcom, products(name, image_url)')
      .eq('order_id', id)
      .order('id', { ascending: true });
    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, valor, forma_pagamento, origem, criado_em, taxa_cartao_valor, valor_recebido, troco, troco_via_pix')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });
    const saldo = await this.salaoService.saldoDevedor(id);
    return { ...comanda, itens, pagamentos: pagamentos ?? [], saldo };
  }

  // Pagamento parcial registrado pelo caixa — mesma regra do garçom (não fecha sozinho).
  async registrarPagamentoParcial(id: number, restaurantId: number, valor: number, formaPagamento: string, valorRecebido?: number, trocoViaPix = false) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }
    const identificador = `Comanda #${comanda.numero_comanda ?? id}`;
    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valor, formaPagamento);
    return this.salaoService.registrarPagamento(id, 'estabelecimento', valor, formaPagamento, restaurantId, valorRecebido, identificador, taxaCartaoValor, trocoViaPix);
  }

  private async buscarPagamento(comandaId: number, pagamentoId: number) {
    const { data } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, forma_pagamento, valor, valor_recebido, troco, troco_via_pix')
      .eq('id', pagamentoId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Pagamento não encontrado');
    return data;
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

    const identificador = `Comanda #${comanda.numero_comanda ?? comandaId}`;

    if (comanda.status === 'paga') {
      await this.garantirCaixaAbertoDaComanda(comanda);
      const anterior = await this.buscarPagamento(comandaId, pagamentoId);
      // Só a forma muda aqui (valor travado) — estorna o que foi creditado na forma
      // antiga e credita de novo na forma nova, senão trocar "dinheiro" por "pix" deixa
      // o dinheiro fantasma no caixa físico.
      await this.salaoService.estornarPagamentoEmDinheiro(restaurantId, identificador, anterior);
      const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, anterior.valor, formaPagamento);
      const { error } = await this.supabase.client
        .from('comanda_pagamentos')
        .update({ forma_pagamento: formaPagamento, taxa_cartao_valor: taxaCartaoValor || null })
        .eq('id', pagamentoId);
      if (error) throw error;
      if (formaPagamento === 'cash') {
        await this.salaoService.registrarEntradaCaixa(restaurantId, `Venda em dinheiro (corrigido) - ${identificador}`, anterior.valor_recebido ?? anterior.valor, 'venda_dinheiro');
      }
      // orders.payment_method só é usado como resumo de exibição quando não há
      // comanda_pagamentos — mantém em sincronia mesmo assim, evita confusão no recibo.
      await this.supabase.client.from('orders').update({ payment_method: formaPagamento }).eq('id', comandaId);
      return this.comandaDetalhe(comandaId, restaurantId);
    }

    if (!valor || valor <= 0) throw new BadRequestException('Valor precisa ser maior que zero');
    const anterior = await this.buscarPagamento(comandaId, pagamentoId);
    await this.salaoService.estornarPagamentoEmDinheiro(restaurantId, identificador, anterior);

    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valor, formaPagamento);
    const { error } = await this.supabase.client
      .from('comanda_pagamentos')
      .update({ valor, forma_pagamento: formaPagamento, taxa_cartao_valor: taxaCartaoValor || null })
      .eq('id', pagamentoId);
    if (error) throw error;

    if (formaPagamento === 'cash') {
      await this.salaoService.registrarEntradaCaixa(restaurantId, `Venda em dinheiro (corrigido) - ${identificador}`, valor, 'venda_dinheiro');
    }

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  async removerPagamentoParcial(comandaId: number, restaurantId: number, pagamentoId: number) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const pagamento = await this.buscarPagamento(comandaId, pagamentoId);

    const { error } = await this.supabase.client.from('comanda_pagamentos').delete().eq('id', pagamentoId);
    if (error) throw error;

    await this.salaoService.estornarPagamentoEmDinheiro(restaurantId, `Comanda #${comanda.numero_comanda ?? comandaId}`, pagamento);

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  // Exclusivo do estabelecimento: garçom pode ter fechado a comanda informando troco em
  // dinheiro sem a opção de Pix, e o caixa quer corrigir depois (ex: caixa físico ficou
  // sem fundo pra devolver aquele troco). Só mexe na forma do troco — valor/forma do
  // pagamento em si ficam intactos.
  async alterarTrocoPix(comandaId: number, restaurantId: number, pagamentoId: number, trocoViaPix: boolean) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    const pagamento = await this.buscarPagamento(comandaId, pagamentoId);
    if (pagamento.forma_pagamento !== 'cash' || !((pagamento.troco ?? 0) > 0)) {
      throw new BadRequestException('Esse pagamento não tem troco em dinheiro pra alterar');
    }
    if (!!pagamento.troco_via_pix === trocoViaPix) {
      return this.comandaDetalhe(comandaId, restaurantId);
    }

    await this.garantirCaixaAbertoDaComanda(comanda);

    const troco = pagamento.troco as number;
    if (!trocoViaPix) {
      const saldoEspecie = await this.salaoService.saldoEspecieDisponivel(restaurantId);
      if (saldoEspecie < troco) {
        throw new BadRequestException(
          `Caixa não tem troco suficiente em espécie (disponível: R$ ${saldoEspecie.toFixed(2)}, necessário: R$ ${troco.toFixed(2)}).`,
        );
      }
    }

    const identificador = `Comanda #${comanda.numero_comanda ?? comandaId}`;
    // Estorna o troco no meio que ele saiu antes, lança de novo no meio novo.
    await this.salaoService.registrarEntradaCaixa(
      restaurantId, `Estorno troco (correção) - ${identificador}`, troco, 'estorno_troco', pagamento.troco_via_pix ? 'pix' : 'dinheiro',
    );
    await this.salaoService.registrarSaidaCaixa(
      restaurantId, `Troco${trocoViaPix ? ' via Pix' : ''} (correção) - ${identificador}`, troco, trocoViaPix ? 'troco_pix' : 'troco', trocoViaPix ? 'pix' : 'dinheiro',
    );

    const { error } = await this.supabase.client.from('comanda_pagamentos').update({ troco_via_pix: trocoViaPix }).eq('id', pagamentoId);
    if (error) throw error;

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  // Venda balcão: comanda avulsa (sem mesa) aberta pelo próprio operador, sem exigir
  // nome/telefone de cliente. Daqui em diante usa os mesmos endpoints de comanda
  // normal (itens, desconto/acréscimo, pagamento parcial multi-forma, pagar) — evita
  // duplicar a lógica de pagamento/taxa de cartão que já existe pra mesa/comanda.
  async abrirVendaBalcao(restaurantId: number, userId: string) {
    const { data: caixaAberto } = await this.supabase.client
      .from('caixas').select('id').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();
    if (!caixaAberto) throw new BadRequestException('Abra o caixa antes de vender');

    const { data: userData } = await this.supabase.client.auth.admin.getUserById(userId);
    const nomeCompleto = userData?.user?.user_metadata?.name as string | undefined;
    const abertoPorNome = nomeCompleto?.trim().split(' ')[0] || null;
    const numeroComanda = await this.proximoNumeroComanda(restaurantId);

    const { data: venda, error } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        canal: 'presencial',
        status: 'aberta',
        cliente_mesa_nome: 'Venda balcão',
        total: 0,
        caixa_id: caixaAberto.id,
        is_venda_balcao: true,
        aberto_por_nome: abertoPorNome,
        numero_comanda: numeroComanda,
      })
      .select('id')
      .single();
    if (error) throw error;

    return this.comandaDetalhe(venda.id, restaurantId);
  }

  // Painel de chamada (Salão): lista comandas de venda balcão com ao menos 1 item já
  // enviado pra produção (enviado/preparando/pronto) e ainda não entregue (entregue_garcom
  // cobre delivery de garçom E balcão, já que balcão não tem garçom envolvido). Agrupa por
  // comanda pra chamar o cliente uma vez só mesmo com itens de setores diferentes
  // (cozinha+bar). Comanda começa 'aguardando' (nenhum item ainda iniciado), vira
  // 'preparando' assim que qualquer item entra em preparo, e só vira 'pronto' quando
  // TODOS os itens ficarem prontos — aí sim entra no ciclo de chamada (bipe/flash) da
  // tela. Ordenada pela hora do primeiro item enviado, então reflete a ordem real dos
  // pedidos.
  //
  // Identificação na tela: NUNCA o nome de quem abriu a venda (o operador/caixa) — o
  // cliente não faz ideia de quem é o caixa. Usa o número da comanda (sempre visível,
  // impresso no ticket que o cliente fica com a mão) + o nome do cliente quando ele
  // informa (ver editarClienteComandaSalao); sem nome, mostra só o número.
  async filaChamadaBalcao(restaurantId: number) {
    const { data: itens, error } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, status, enviado_em, pronto_em, entregue_garcom, order_id, products(name), orders!inner(id, restaurant_id, is_venda_balcao, numero_comanda, cliente_mesa_nome, chamado_count, ultima_chamada_em)')
      .eq('orders.restaurant_id', restaurantId)
      .eq('orders.is_venda_balcao', true)
      .in('status', ['enviado', 'preparando', 'pronto'])
      .eq('entregue_garcom', false)
      .order('enviado_em', { ascending: true });
    if (error) throw error;

    const porComanda = new Map<number, any>();
    for (const i of itens as any[]) {
      const o = i.orders;
      if (!porComanda.has(o.id)) {
        const nomeCliente = o.cliente_mesa_nome && o.cliente_mesa_nome !== 'Venda balcão' ? o.cliente_mesa_nome : null;
        const identificacao = o.numero_comanda ? `Nº ${o.numero_comanda}` : 'Balcão';
        porComanda.set(o.id, {
          order_id: o.id,
          cliente: nomeCliente ? `${identificacao} - ${nomeCliente}` : identificacao,
          chamado_count: o.chamado_count ?? 0,
          ultima_chamada_em: o.ultima_chamada_em,
          enviado_em: i.enviado_em,
          itens: [],
        });
      }
      const c = porComanda.get(o.id);
      c.itens.push({ id: i.id, product_name: i.products?.name, quantity: i.quantity, status: i.status });
      if (i.enviado_em < c.enviado_em) c.enviado_em = i.enviado_em;
    }

    const fila = [...porComanda.values()].map((c) => {
      const todosProntos = c.itens.every((item: any) => item.status === 'pronto');
      const nenhumIniciado = c.itens.every((item: any) => item.status === 'enviado');
      return { ...c, status: todosProntos ? 'pronto' : nenhumIniciado ? 'aguardando' : 'preparando' };
    });
    fila.sort((a, b) => a.enviado_em.localeCompare(b.enviado_em));

    return { fila };
  }

  // Incrementa o contador de chamados (bipe+pisca) — chamado pelo front a cada ciclo
  // de 7s enquanto a comanda estiver em destaque na tela de chamada.
  async marcarChamada(orderId: number, restaurantId: number) {
    const { data: order } = await this.supabase.client
      .from('orders').select('id, chamado_count').eq('id', orderId).eq('restaurant_id', restaurantId).eq('is_venda_balcao', true).maybeSingle();
    if (!order) throw new NotFoundException('Comanda de balcão não encontrada');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ chamado_count: (order.chamado_count ?? 0) + 1, ultima_chamada_em: new Date().toISOString() })
      .eq('id', orderId);
    if (error) throw error;
    return { ok: true };
  }

  // Marca item de venda balcão como entregue — sem garçom envolvido, então não usa
  // garantirComandaDoGarcom (essa é escopo dono/operador via restaurantId).
  async marcarItemBalcaoEntregue(orderId: number, restaurantId: number, itemId: number) {
    const { data: order } = await this.supabase.client
      .from('orders').select('id').eq('id', orderId).eq('restaurant_id', restaurantId).eq('is_venda_balcao', true).maybeSingle();
    if (!order) throw new NotFoundException('Comanda de balcão não encontrada');

    const { data: item } = await this.supabase.client
      .from('order_items').select('id').eq('id', itemId).eq('order_id', orderId).maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const { error } = await this.supabase.client
      .from('order_items').update({ entregue_garcom: true, entregue_em: new Date().toISOString() }).eq('id', itemId);
    if (error) throw error;
    return { ok: true };
  }

  async editarClienteMesa(id: number, restaurantId: number, body: { cliente_nome: string; cliente_telefone?: string }) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Só é possível editar comandas abertas ou aguardando pagamento');
    }
    if (!body.cliente_nome?.trim()) throw new BadRequestException('Nome do cliente é obrigatório');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ cliente_mesa_nome: body.cliente_nome.trim(), cliente_mesa_telefone: body.cliente_telefone?.trim() || null })
      .eq('id', id);
    if (error) throw error;

    return this.comandaDetalhe(id, restaurantId);
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
      if (!prod.is_active) throw new BadRequestException(`Produto ${item.product_id} inativo`);
    }

    // Combo explode nas linhas dos produtos reais (mesma observação copiada pra cada linha).
    const linhasCombo = (
      await Promise.all(
        itensCombo.map(async (i) => {
          const linhas = await this.combos.expandir(i.combo_id as number, i.quantity, restaurantId);
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
        order_id: id,
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

    const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', id);
    const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', id);

    // Item fica pendente até o operador confirmar com "Enviar novos itens" (ver
    // enviarItensPendentes) — evita que a cozinha veja e logo em seguida perca um item
    // que foi corrigido/apagado por engano na hora do lançamento. Venda balcão segue o
    // mesmo caminho e só dispara o envio de fato lá no pagamento (ver `pagar`).
    return this.comandaDetalhe(id, restaurantId);
  }

  // Botão "Enviar novos itens" do caixa/balcão — mesma ideia do garçom (enviarItens em
  // salao.service.ts), só que sem exigir garcom_id. Fechar/pagar a comanda com item ainda
  // pendente é bloqueado (ver `pagar`), então esse é o único jeito de mandar pra produção.
  async enviarItensPendentes(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    return this.salaoService.enviarItensComoRestaurante(id, comanda);
  }

  // Estabelecimento pode remover qualquer item (pendente ou já enviado) — diferente do
  // garçom, que só mexe em item ainda não enviado (ver salao.service.ts).
  // Estabelecimento pode editar qualquer item (pendente ou já enviado) — diferente do
  // garçom, que só mexe em item ainda não enviado (ver salao.service.ts).
  async editarItem(comandaId: number, restaurantId: number, itemId: number, body: { quantity?: number; observacao?: string }) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    // Venda balcão só envia os itens pra cozinha/bar depois de paga (ver `adicionarItens`/
    // `pagar`) — quando o item chega na Produção a comanda já está com status 'paga', então
    // precisa liberar edição de observação mesmo paga (só pra venda balcão; quantidade
    // continua travada, já foi cobrada).
    const podeEditar = ['aberta', 'fechada_garcom'].includes(comanda.status)
      || (comanda.is_venda_balcao && comanda.status === 'paga');
    if (!podeEditar) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }
    if (comanda.status === 'paga' && body.quantity !== undefined) {
      throw new BadRequestException('Não é possível alterar quantidade de uma venda já finalizada');
    }

    const { data: item } = await this.supabase.client
      .from('order_items').select('id, product_id, quantity').eq('id', itemId).eq('order_id', comandaId).maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const update: Record<string, unknown> = {};
    if (body.quantity !== undefined) {
      if (body.quantity < 1) throw new BadRequestException('Quantidade mínima é 1');
      update.quantity = body.quantity;
    }
    if (body.observacao !== undefined) update.observacao = body.observacao?.trim() || null;

    const { error } = await this.supabase.client.from('order_items').update(update).eq('id', itemId);
    if (error) throw error;

    if (body.quantity !== undefined && body.quantity !== item.quantity) {
      await this.estoque.ajustarPorDelta(item.product_id, item.quantity, body.quantity);
    }

    if (comanda.status !== 'paga') {
      const { data: todosItens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comandaId);
      const total = (todosItens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
      await this.supabase.client.from('orders').update({ total: parseFloat(total.toFixed(2)) }).eq('id', comandaId);
    }

    return this.comandaDetalhe(comandaId, restaurantId);
  }

  async removerItem(comandaId: number, restaurantId: number, itemId: number) {
    const comanda = await this.buscarComanda(comandaId, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity')
      .eq('id', itemId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const { error } = await this.supabase.client.from('order_items').delete().eq('id', itemId);
    if (error) throw error;

    await this.estoque.restaurarItens([{ product_id: item.product_id, quantity: item.quantity }]);

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

  // Separa itens escolhidos pra uma comanda avulsa nova — pro caso de um cliente da
  // mesa querer pagar só o que ele consumiu, sem mexer no resto da conta dos outros.
  async dividirComanda(origemId: number, restaurantId: number, itemIds: number[], clienteNome: string, clienteTelefone?: string) {
    if (!itemIds?.length) throw new BadRequestException('Selecione ao menos 1 item pra separar');
    if (!clienteNome?.trim()) throw new BadRequestException('Informe o nome do cliente da nova comanda');

    const origem = await this.buscarComanda(origemId, restaurantId);
    if (origem.status !== 'aberta') throw new BadRequestException('Só é possível dividir comandas abertas');

    const { data: itensOrigem } = await this.supabase.client
      .from('order_items').select('id').eq('order_id', origemId);
    const idsValidos = new Set((itensOrigem ?? []).map((i: any) => i.id));
    const idsParaMover = [...new Set(itemIds)].filter((id) => idsValidos.has(id));
    if (!idsParaMover.length) throw new BadRequestException('Nenhum item válido selecionado');
    if (idsParaMover.length === idsValidos.size) {
      throw new BadRequestException('Selecione menos que todos os itens — pra mover a comanda inteira use transferir');
    }

    const { data: caixaAberto } = await this.supabase.client
      .from('caixas').select('id').eq('restaurant_id', restaurantId).eq('status', 'aberto').maybeSingle();

    const { data: novaComanda, error: errNova } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        canal: 'presencial',
        status: 'aberta',
        garcom_id: origem.garcom_id ?? null,
        cliente_mesa_nome: clienteNome.trim(),
        cliente_mesa_telefone: clienteTelefone?.trim() || null,
        total: 0,
        caixa_id: caixaAberto?.id ?? null,
      })
      .select('id')
      .single();
    if (errNova) throw errNova;

    const { error: errMove } = await this.supabase.client
      .from('order_items')
      .update({ order_id: novaComanda.id })
      .eq('order_id', origemId)
      .in('id', idsParaMover);
    if (errMove) throw errMove;

    const { data: itensRestantes } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', origemId);
    const totalOrigem = (itensRestantes ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(totalOrigem.toFixed(2)) }).eq('id', origemId);

    const { data: itensNovos } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', novaComanda.id);
    const totalNova = (itensNovos ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    await this.supabase.client.from('orders').update({ total: parseFloat(totalNova.toFixed(2)) }).eq('id', novaComanda.id);

    return { ok: true, comanda_nova_id: novaComanda.id };
  }

  async cancelar(id: number, restaurantId: number) {
    const comanda = await this.buscarComanda(id, restaurantId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Só é possível cancelar comandas abertas ou aguardando pagamento');
    }

    const { error } = await this.supabase.client.from('orders').update({ status: 'canceled' }).eq('id', id);
    if (error) throw error;

    await this.estoque.restaurarItensDoPedido(id);
    await this.salaoService.estornarPagamentosDaComanda(restaurantId, id, `Comanda #${comanda.numero_comanda ?? id} (cancelada)`);

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

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, origem, taxa_cartao_valor, valor_recebido, troco, troco_via_pix')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });

    const conteudo = this.salaoService.formatarConferenciaTexto(restaurante?.name, comanda, itensFormatados, valores, pagamentos ?? []);
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

  // gorjetaDireta: cliente pagou a gorjeta direto pro garçom (pix/dinheiro), por fora
  // do caixa do estabelecimento — não cobra na comanda nem entra no gorjeta_valor (que
  // alimenta o relatório de repasse do garçom, senão contaria a mesma gorjeta 2x: o
  // garçom já ficou com o dinheiro na mão, não tem o que repassar).
  async pagar(id: number, restaurantId: number, formaPagamento: string, gorjetaValor?: number, valorRecebido?: number, gorjetaDireta?: boolean, trocoViaPix = false) {
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    const comanda = await this.buscarComanda(id, restaurantId);
    if (comanda.status !== 'fechada_garcom' && comanda.status !== 'aberta') {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price, status, products(name)').eq('order_id', id);
    // Venda balcão é a exceção: ali todo item fica pendente de propósito até esse exato
    // pagamento (ver `adicionarItens`), que é quem dispara o envio — não bloqueia. Comanda
    // normal já deveria ter mandado tudo antes via "Enviar novos itens".
    if (!comanda.is_venda_balcao && (itens ?? []).some((i: any) => i.status === 'pendente')) {
      throw new BadRequestException('Tem item ainda não enviado pra produção: envie os itens antes de fechar a comanda');
    }
    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const totalFinal = subtotal - (comanda.desconto_valor ?? 0) + (comanda.acrescimo_valor ?? 0);

    // Se já teve pagamento parcial (garçom ou caixa), só registra o que ainda falta —
    // o ledger de comanda_pagamentos fica completo pra conferência.
    const { saldo } = await this.salaoService.saldoDevedor(id);
    // Fechamento não cobre mais o saldo restante sozinho — o operador é obrigado a lançar
    // os pagamentos parciais (com a forma correta de cada um) até o saldo zerar antes de
    // poder fechar. Evita fechar tudo numa forma só quando o cliente pagou split.
    if (saldo > 0.01) {
      throw new BadRequestException('Saldo devedor pendente: registre os pagamentos até zerar o saldo antes de fechar a comanda');
    }
    const gorjeta = gorjetaDireta ? 0 : (gorjetaValor ?? 0);
    const valorACobrarBase = parseFloat(gorjeta.toFixed(2));
    const taxaCartaoValor = await this.salaoService.calcularTaxaCartao(restaurantId, valorACobrarBase, formaPagamento);
    // A essa altura o saldo dos itens já está zerado — só falta cobrar a gorjeta (se houver).
    const valorACobrar = parseFloat((valorACobrarBase + taxaCartaoValor).toFixed(2));
    let troco: number | null = null;
    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      if (valorRecebido < valorACobrar) throw new BadRequestException('Valor recebido não pode ser menor que o valor a pagar');
      troco = parseFloat((valorRecebido - valorACobrar).toFixed(2));
      // Troco via Pix não sai da espécie física do caixa — não precisa checar fundo.
      if (troco > 0 && !trocoViaPix) {
        const saldoEspecie = await this.salaoService.saldoEspecieDisponivel(restaurantId);
        if (saldoEspecie < troco) {
          throw new BadRequestException(
            `Caixa não tem troco suficiente em espécie (disponível: R$ ${saldoEspecie.toFixed(2)}, necessário: R$ ${troco.toFixed(2)}). Registre uma Adição no caixa antes de finalizar esse pagamento, ou marque "Troco via Pix".`,
          );
        }
      }
    }

    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      const identificador = `Comanda #${comanda.numero_comanda ?? id}`;
      await this.salaoService.registrarEntradaCaixa(restaurantId, `Venda em dinheiro - ${identificador}`, valorRecebido, 'venda_dinheiro');
      if (troco && troco > 0) {
        if (trocoViaPix) {
          await this.salaoService.registrarSaidaCaixa(restaurantId, `Troco via Pix - ${identificador}`, troco, 'troco_pix', 'pix');
        } else {
          await this.salaoService.registrarSaidaCaixa(restaurantId, `Troco - ${identificador}`, troco, 'troco');
        }
      }
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
        // Direto pro garçom não conta gorjeta_valor — é isso que alimenta o repasse
        // (ver getRelatorioGarcom) e o valor cobrado da comanda.
        gorjeta_valor: gorjetaDireta ? null : (gorjetaValor ?? null),
        caixa_id: caixaId,
        pago_em: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', comanda.mesa_id);
    }

    // Venda balcão segurou o envio dos itens até aqui (ver `adicionarItens`) — manda tudo
    // pra cozinha/bar de uma vez agora que a venda foi finalizada.
    if (comanda.is_venda_balcao) {
      await this.salaoService.enviarItensComoRestaurante(id, comanda);
    }

    await this.lancarComissoes(comanda, subtotal, totalFinal);

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, origem, taxa_cartao_valor, valor_recebido, troco, troco_via_pix')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });

    // Soma a taxa de TODOS os pagamentos da comanda (garçom + caixa, parciais e final) —
    // usar só taxaCartaoValor (da última parcela) subestimava o recibo quando já havia
    // pagamento parcial anterior em cartão.
    const taxaCartaoTotalRecibo = (pagamentos ?? []).reduce((acc, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);
    // TOTAL do recibo é o valor geral da comanda inteira (produtos +/- desconto/acréscimo
    // + gorjeta + taxa) — não "quanto faltava cobrar agora", que pode ser zero quando
    // pagamentos parciais anteriores já cobriram tudo.
    const totalGeralRecibo = parseFloat((totalFinal + gorjeta + taxaCartaoTotalRecibo).toFixed(2));

    const recibo = await this.salaoService.imprimirReciboSeConfigurado(
      restaurantId, comanda,
      (itens ?? []).map((i: any) => ({ product_name: i.products?.name, quantity: i.quantity, unit_price: i.unit_price })),
      {
        subtotal,
        desconto: comanda.desconto_valor ?? 0,
        acrescimo: comanda.acrescimo_valor ?? 0,
        gorjeta,
        taxaCartao: taxaCartaoTotalRecibo,
        total: totalGeralRecibo,
        formaPagamento,
        trocoDado: troco && troco > 0 ? troco : 0,
        trocoViaPix,
      },
      pagamentos ?? [],
    );

    return {
      ok: true, total: parseFloat(totalFinal.toFixed(2)), total_geral: totalGeralRecibo,
      taxa_cartao_valor: taxaCartaoTotalRecibo, valor_cobrado: valorACobrar,
      troco, troco_via_pix: troco && troco > 0 ? trocoViaPix : false, recibo, pagamentos: pagamentos ?? [],
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
      .select('valor, forma_pagamento, origem, taxa_cartao_valor, valor_recebido, troco, troco_via_pix')
      .eq('order_id', id)
      .order('criado_em', { ascending: true });

    const taxaCartaoValor = (pagamentos ?? []).reduce((acc: number, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);
    // TOTAL do recibo é o valor geral da comanda (comanda.total já é subtotal +/- desconto/
    // acréscimo, salvo no pagamento) somado à gorjeta e à taxa de cartão total — não o
    // valor bruto salvo em orders.total, que sozinho não inclui gorjeta/taxa.
    const totalGeralRecibo = parseFloat(((comanda.total ?? 0) + (comanda.gorjeta_valor ?? 0) + taxaCartaoValor).toFixed(2));

    const recibo = await this.salaoService.imprimirReciboSeConfigurado(
      restaurantId, comanda,
      (itens ?? []).map((i: any) => ({ product_name: i.products?.name, quantity: i.quantity, unit_price: i.unit_price })),
      {
        subtotal,
        desconto: comanda.desconto_valor ?? 0,
        acrescimo: comanda.acrescimo_valor ?? 0,
        gorjeta: comanda.gorjeta_valor ?? 0,
        taxaCartao: taxaCartaoValor,
        total: totalGeralRecibo,
        formaPagamento: comanda.payment_method,
        trocoDado: 0,
      },
      pagamentos ?? [],
    );

    return { ok: true, recibo, subtotal, total: totalGeralRecibo, taxa_cartao_valor: taxaCartaoValor, pagamentos: pagamentos ?? [] };
  }
}

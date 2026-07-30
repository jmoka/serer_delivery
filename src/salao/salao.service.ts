import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EstoqueService } from '../estoque/estoque.service';

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
  constructor(
    private supabase: SupabaseService,
    private estoque: EstoqueService,
  ) {}

  async mesas(restaurantId: number) {
    const { data: mesas, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;

    // Precisa saber de quem é a comanda em cada mesa ocupada — o garçom só pode
    // clicar/entrar se a comanda for dele (ver garcom-portal, grid de mesas).
    const { data: comandas } = await this.supabase.client
      .from('orders')
      .select('id, mesa_id, garcom_id, cliente_mesa_nome, total, garcons(nome), aberto_por_nome, conferencia_solicitada_em')
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .not('mesa_id', 'is', null);

    const comandaPorMesa = new Map((comandas ?? []).map((c: any) => [c.mesa_id, c]));

    return (mesas ?? []).map((m: any) => ({ ...m, comanda: comandaPorMesa.get(m.id) ?? null }));
  }

  // Acompanhamento público via QR (ideia 13) — sem auth, só o essencial pro cliente da mesa.
  async acompanharPorToken(token: string) {
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('id, restaurant_id, status, numero_comanda, desconto_valor, acrescimo_valor, gorjeta_valor, conferencia_solicitada_em, mesas(numero, nome), restaurants(name, gorjeta_percentual)')
      .eq('tracking_token', token)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!comanda) throw new NotFoundException('Comanda não encontrada');

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('id, quantity, unit_price, status, enviado_em, preparando_em, products(name)')
      .eq('order_id', comanda.id)
      .order('id', { ascending: true });

    // Mesma fila e mesmas médias que o garçom vê — o cliente não precisa perguntar
    // "quantos faltam antes do meu" ou "quanto tempo em média demora".
    const fila = await this.filaCozinha((comanda as any).restaurant_id);
    const aguardandoIds = fila.itens.filter((i) => i.status === 'enviado').map((i) => i.item_id);
    const preparandoIds = fila.itens.filter((i) => i.status === 'preparando').map((i) => i.item_id);

    // Conta pra conferência visual — mesmos números que o caixa usa pra fechar (ver
    // saldoDevedor), o cliente confere sem precisar perguntar "quanto já deu".
    const saldo = await this.saldoDevedor(comanda.id);
    const percentualGorjeta = (comanda as any).restaurants?.gorjeta_percentual ?? 0;

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('valor, forma_pagamento, criado_em, taxa_cartao_valor')
      .eq('order_id', comanda.id)
      .order('criado_em', { ascending: true });
    const taxaCartaoTotal = (pagamentos ?? []).reduce((acc: number, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);

    // gorjeta_valor só é gravado quando a comanda é paga (garçom/caixa escolhe o valor
    // na hora) — enquanto a comanda ainda está aberta o cliente não vê nenhuma gorjeta
    // no Total/Falta pagar, mesmo o restaurante tendo um percentual sugerido configurado.
    // Estimativa: calcula em cima do percentual pra já aparecer no acompanhamento antes
    // do pagamento; quando pago, usa o valor real cobrado (não recalcula).
    const gorjetaJaDefinida = (comanda as any).gorjeta_valor !== null && (comanda as any).gorjeta_valor !== undefined;
    const gorjetaEstimativa = !gorjetaJaDefinida && comanda.status !== 'paga' && percentualGorjeta > 0;
    let gorjetaValor = (comanda as any).gorjeta_valor ?? 0;
    let totalComGorjeta = saldo.total;
    let saldoComGorjeta = saldo.saldo;
    if (gorjetaEstimativa) {
      const baseCalculo = saldo.subtotal - ((comanda as any).desconto_valor ?? 0) + ((comanda as any).acrescimo_valor ?? 0);
      gorjetaValor = parseFloat(((baseCalculo * percentualGorjeta) / 100).toFixed(2));
      totalComGorjeta = parseFloat((saldo.total + gorjetaValor).toFixed(2));
      saldoComGorjeta = parseFloat((saldo.saldo + gorjetaValor).toFixed(2));
    }

    return {
      restaurante: (comanda as any).restaurants?.name,
      mesa: (comanda as any).mesas ? `Mesa ${(comanda as any).mesas.numero}` : null,
      numero_comanda: (comanda as any).numero_comanda,
      status: comanda.status,
      conferencia_solicitada_em: (comanda as any).conferencia_solicitada_em,
      tempoMedioEsperaSegundos: fila.tempoMedioEsperaSegundos,
      tempoMedioPreparoSegundos: fila.tempoMedioPreparoSegundos,
      tempoMedioGeralSegundos: fila.tempoMedioGeralSegundos,
      subtotal: saldo.subtotal,
      desconto: (comanda as any).desconto_valor ?? 0,
      acrescimo: (comanda as any).acrescimo_valor ?? 0,
      gorjeta_percentual: percentualGorjeta,
      gorjeta: gorjetaValor,
      gorjeta_estimativa: gorjetaEstimativa,
      total: totalComGorjeta,
      total_pago: saldo.total_pago,
      taxa_cartao_total: parseFloat(taxaCartaoTotal.toFixed(2)),
      saldo: saldoComGorjeta,
      pagamentos: (pagamentos ?? []).map((p: any) => ({
        valor: p.valor,
        forma_pagamento: p.forma_pagamento,
        criado_em: p.criado_em,
        taxa_cartao_valor: p.taxa_cartao_valor ?? 0,
      })),
      itens: (itens ?? []).map((i: any) => ({
        quantity: i.quantity,
        unit_price: i.unit_price,
        subtotal: parseFloat((i.quantity * i.unit_price).toFixed(2)),
        status: i.status,
        enviado_em: i.enviado_em,
        preparando_em: i.preparando_em,
        product_name: i.products?.name,
        posicao_fila:
          i.status === 'enviado' ? aguardandoIds.indexOf(i.id) + 1
          : i.status === 'preparando' ? preparandoIds.indexOf(i.id) + 1
          : null,
      })),
    };
  }

  async produtos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, name, price, image_url, category_id, quantidade_estoque, categories(name)')
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .gt('quantidade_estoque', 0)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((p: any) => ({ ...p, category_name: p.categories?.name ?? 'Outros' }));
  }

  private async garantirComandaDoGarcom(comandaId: number, garcomId: number) {
    const { data } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, mesa_id, garcom_id, numero_comanda, cliente_mesa_nome, cliente_mesa_telefone, tracking_token, desconto_valor, acrescimo_valor, gorjeta_valor, mesas(numero, nome), garcons(nome)')
      .eq('id', comandaId)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!data) throw new NotFoundException('Comanda não encontrada');
    if (data.garcom_id !== garcomId) throw new ForbiddenException('Comanda não pertence a este garçom');
    return data;
  }

  // Débito/crédito acrescentam a taxa configurada em Config > "Taxa do cartão" — o valor
  // cobrado do cliente aumenta, PIX e dinheiro não são afetados. Compartilhado entre o
  // fechamento do caixa (SalaoPdvService) e o pagamento parcial feito pelo garçom.
  async calcularTaxaCartao(restaurantId: number, valor: number, formaPagamento: string): Promise<number> {
    if (formaPagamento !== 'credit_card' && formaPagamento !== 'debit_card') return 0;
    if (!(valor > 0)) return 0;
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('taxa_cartao_percentual')
      .eq('id', restaurantId)
      .maybeSingle();
    const percentual = restaurante?.taxa_cartao_percentual ?? 0;
    return parseFloat(((valor * percentual) / 100).toFixed(2));
  }

  // Saldo devedor considerando pagamentos parciais já registrados (garçom ou caixa).
  // Total = produtos - desconto + acréscimo manual + gorjeta + taxa de cartão já
  // aplicada nos pagamentos feitos — pra "falta pagar" bater com a conta real, não
  // só o valor dos produtos (gorjeta/taxa de cartão eram ignoradas antes).
  async saldoDevedor(comandaId: number) {
    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comandaId);
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('desconto_valor, acrescimo_valor, gorjeta_valor')
      .eq('id', comandaId)
      .maybeSingle();
    const { data: pagamentos } = await this.supabase.client.from('comanda_pagamentos').select('valor, taxa_cartao_valor').eq('order_id', comandaId);

    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const totalTaxaCartao = (pagamentos ?? []).reduce((acc: number, p: any) => acc + (p.taxa_cartao_valor ?? 0), 0);
    const totalFinal = subtotal - (comanda?.desconto_valor ?? 0) + (comanda?.acrescimo_valor ?? 0) + (comanda?.gorjeta_valor ?? 0) + totalTaxaCartao;
    // total_pago tem que incluir a taxa de cada pagamento — ela já foi cobrada do
    // cliente junto com o valor base. Somar só p.valor (sem a taxa) fazia o saldo
    // devedor contar a taxa já paga como se ainda estivesse em aberto, cobrando ela
    // de novo no fechamento.
    const totalPago = (pagamentos ?? []).reduce((acc: number, p: any) => acc + p.valor + (p.taxa_cartao_valor ?? 0), 0);

    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      total: parseFloat(totalFinal.toFixed(2)),
      total_pago: parseFloat(totalPago.toFixed(2)),
      saldo: parseFloat((totalFinal - totalPago).toFixed(2)),
    };
  }

  // Lança uma saída automática no caixa aberto do restaurante — usado pra registrar troco
  // dado e gorjeta paga em dinheiro, sem o caixa precisar lançar isso manualmente depois.
  async registrarSaidaCaixa(restaurantId: number, descricao: string, valor: number, tipo: 'troco' | 'gorjeta') {
    if (!(valor > 0)) return;
    const { data: caixa } = await this.supabase.client
      .from('caixas')
      .select('id, saidas')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aberto')
      .maybeSingle();
    if (!caixa) return; // sem caixa aberto: melhor não travar o pagamento por isso

    const saidas = (caixa.saidas ?? []) as any[];
    const nova = { descricao, valor, meio: 'dinheiro', tipo, criado_em: new Date().toISOString() };
    await this.supabase.client.from('caixas').update({ saidas: [...saidas, nova] }).eq('id', caixa.id);
  }

  // Lança uma entrada automática no caixa aberto — usado pra registrar o dinheiro que o
  // cliente entregou de fato numa venda em espécie (não o valor da venda, o valor recebido).
  async registrarEntradaCaixa(restaurantId: number, descricao: string, valor: number, tipo: string) {
    if (!(valor > 0)) return;
    const { data: caixa } = await this.supabase.client
      .from('caixas')
      .select('id, entradas')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aberto')
      .maybeSingle();
    if (!caixa) return;

    const entradas = (caixa.entradas ?? []) as any[];
    const nova = { descricao, valor, meio: 'dinheiro', tipo, criado_em: new Date().toISOString() };
    await this.supabase.client.from('caixas').update({ entradas: [...entradas, nova] }).eq('id', caixa.id);
  }

  // Espécie disponível agora no caixa aberto — soma direto do ledger (fundo + entradas em
  // dinheiro − saídas em dinheiro), sem precisar reconsultar pedidos. Usado pra bloquear
  // troco ou sangria sem fundo suficiente.
  async saldoEspecieDisponivel(restaurantId: number): Promise<number> {
    const { data: caixa } = await this.supabase.client
      .from('caixas')
      .select('valor_inicial, entradas, saidas')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aberto')
      .maybeSingle();
    if (!caixa) return 0;
    const emDinheiro = (arr: any[]) => ((arr ?? []) as any[])
      .filter((x) => !x.meio || x.meio === 'dinheiro')
      .reduce((s: number, x: any) => s + (x.valor ?? 0), 0);
    const saldo = (caixa.valor_inicial ?? 0) + emDinheiro(caixa.entradas) - emDinheiro(caixa.saidas);
    return parseFloat(saldo.toFixed(2));
  }

  // Registra um pagamento parcial — não fecha a comanda sozinho, só abate do saldo devedor.
  // Chamado tanto pelo garçom (informar forma de pagamento) quanto pelo caixa (conferência).
  // Em dinheiro, valorRecebido é o que o cliente entregou — troco é calculado e vira saída
  // automática no caixa (ver registrarSaidaCaixa).
  async registrarPagamento(
    comandaId: number,
    origem: 'garcom' | 'estabelecimento',
    valor: number,
    formaPagamento: string,
    restaurantId: number,
    valorRecebido?: number,
    identificador?: string,
    taxaCartaoValor?: number,
  ) {
    if (!valor || valor <= 0) throw new BadRequestException('Valor precisa ser maior que zero');
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    let troco: number | null = null;
    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      if (valorRecebido < valor) throw new BadRequestException('Valor recebido não pode ser menor que o valor a pagar');
      troco = parseFloat((valorRecebido - valor).toFixed(2));
      if (troco > 0) {
        const saldoEspecie = await this.saldoEspecieDisponivel(restaurantId);
        if (saldoEspecie < troco) {
          throw new BadRequestException(
            `Caixa não tem troco suficiente em espécie (disponível: R$ ${saldoEspecie.toFixed(2)}, necessário: R$ ${troco.toFixed(2)}). Registre uma Adição no caixa antes de finalizar esse pagamento.`,
          );
        }
      }
    }

    const { error } = await this.supabase.client
      .from('comanda_pagamentos')
      .insert({
        order_id: comandaId, valor, forma_pagamento: formaPagamento, origem,
        valor_recebido: valorRecebido ?? null, troco, taxa_cartao_valor: taxaCartaoValor || null,
      });
    if (error) throw error;

    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      await this.registrarEntradaCaixa(restaurantId, `Venda em dinheiro${identificador ? ` - ${identificador}` : ''}`, valorRecebido, 'venda_dinheiro');
      if (troco && troco > 0) {
        await this.registrarSaidaCaixa(restaurantId, `Troco${identificador ? ` - ${identificador}` : ''}`, troco, 'troco');
      }
    }

    return this.saldoDevedor(comandaId);
  }

  // Permissão default true (opt-out) — preserva o comportamento de quem já usava
  // isso sem restrição antes da permissão existir; dono desativa por garçom se quiser.
  async registrarPagamentoComoGarcom(comandaId: number, garcomId: number, valor: number, formaPagamento: string, podePagamentoParcial = true, valorRecebido?: number) {
    if (!podePagamentoParcial) throw new ForbiddenException('Você não tem permissão para registrar pagamento parcial');
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }
    const identificador = `Comanda #${comanda.numero_comanda ?? comandaId}`;
    const taxaCartaoValor = await this.calcularTaxaCartao(comanda.restaurant_id, valor, formaPagamento);
    return this.registrarPagamento(comandaId, 'garcom', valor, formaPagamento, comanda.restaurant_id, valorRecebido, identificador, taxaCartaoValor);
  }

  private async buscarPagamentoDoGarcom(comandaId: number, pagamentoId: number) {
    const { data } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, origem')
      .eq('id', pagamentoId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Pagamento não encontrado');
    // Garçom só edita/remove o que ele mesmo lançou — pagamento do caixa é exclusivo do PDV.
    if (data.origem !== 'garcom') throw new ForbiddenException('Só é possível editar/remover pagamentos lançados por você');
  }

  async editarPagamentoComoGarcom(
    comandaId: number, garcomId: number, pagamentoId: number, valor: number, formaPagamento: string, podePagamentoParcial = true,
  ) {
    if (!podePagamentoParcial) throw new ForbiddenException('Você não tem permissão para registrar pagamento parcial');
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }
    if (!valor || valor <= 0) throw new BadRequestException('Valor precisa ser maior que zero');
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    await this.buscarPagamentoDoGarcom(comandaId, pagamentoId);

    const taxaCartaoValor = await this.calcularTaxaCartao(comanda.restaurant_id, valor, formaPagamento);
    const { error } = await this.supabase.client
      .from('comanda_pagamentos')
      .update({ valor, forma_pagamento: formaPagamento, taxa_cartao_valor: taxaCartaoValor || null })
      .eq('id', pagamentoId);
    if (error) throw error;

    return this.obterComanda(comandaId, garcomId);
  }

  async removerPagamentoComoGarcom(comandaId: number, garcomId: number, pagamentoId: number, podePagamentoParcial = true) {
    if (!podePagamentoParcial) throw new ForbiddenException('Você não tem permissão para registrar pagamento parcial');
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    await this.buscarPagamentoDoGarcom(comandaId, pagamentoId);

    const { error } = await this.supabase.client.from('comanda_pagamentos').delete().eq('id', pagamentoId);
    if (error) throw error;

    return this.obterComanda(comandaId, garcomId);
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

  async abrirComanda(garcomId: number, restaurantId: number, body: AbrirComandaBody, restauranteAberto?: boolean, salaoModo: 'mesas' | 'comandas' | 'ambos' = 'ambos') {
    if (!restauranteAberto) {
      throw new ForbiddenException('Restaurante fechado — não é possível abrir mesa/comanda');
    }
    if (salaoModo === 'mesas' && !body.mesa_id) {
      throw new BadRequestException('Este restaurante só trabalha com mesas — selecione uma mesa');
    }
    if (salaoModo === 'comandas' && body.mesa_id) {
      throw new BadRequestException('Este restaurante só trabalha com comandas avulsas — não vincule a uma mesa');
    }
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

    // Numeração sequencial por dia — só pra identificação fácil ("comanda 3"), reinicia
    // a cada dia. Não precisa ser à prova de corrida (volume baixo de comandas simultâneas).
    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);
    const { count } = await this.supabase.client
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('canal', 'presencial')
      .gte('created_at', inicioDoDia.toISOString());
    const numeroComanda = (count ?? 0) + 1;

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
        numero_comanda: numeroComanda,
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
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, status, total, numero_comanda, created_at, conferencia_solicitada_em')
      .eq('garcom_id', garcomId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  // Itens prontos pra buscar, das comandas abertas desse garçom — o portal dele faz
  // polling nisso pra tocar o alarme sonoro (ver useNotificacaoSonora no front).
  async itensProntos(garcomId: number) {
    const { data: comandas } = await this.supabase.client
      .from('orders')
      .select('id, numero_comanda, mesa_id, cliente_mesa_nome, mesas(numero, nome)')
      .eq('garcom_id', garcomId)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom']);

    const comandaIds = (comandas ?? []).map((c: any) => c.id);
    if (!comandaIds.length) return [];

    const comandaMap = new Map((comandas ?? []).map((c: any) => [c.id, c]));

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('id, order_id, quantity, products(name)')
      .in('order_id', comandaIds)
      .eq('status', 'pronto')
      .eq('entregue_garcom', false);

    return (itens ?? []).map((i: any) => {
      const comanda = comandaMap.get(i.order_id);
      return {
        item_id: i.id,
        order_id: i.order_id,
        numero_comanda: comanda?.numero_comanda ?? i.order_id,
        mesa: comanda?.mesas ? `Mesa ${comanda.mesas.numero}${comanda.mesas.nome ? ' - ' + comanda.mesas.nome : ''}` : null,
        cliente: comanda?.cliente_mesa_nome ?? null,
        product_name: i.products?.name,
        quantity: i.quantity,
      };
    });
  }

  // Fila de preparo do restaurante inteiro (não só as comandas do garçom logado) — o
  // garçom usa isso pra responder ao cliente presencial "quantos faltam antes do meu"
  // e "quanto tempo em média demora", sem precisar ir até a cozinha.
  async filaCozinha(restaurantId: number) {
    const { data: itensRaw, error } = await this.supabase.client
      .from('order_items')
      .select('id, order_id, quantity, status, enviado_em, preparando_em, products(name), orders!inner(restaurant_id, canal, status, numero_comanda, cliente_mesa_nome, mesas(numero, nome))')
      .eq('orders.restaurant_id', restaurantId)
      .eq('orders.canal', 'presencial')
      .in('orders.status', ['aberta', 'fechada_garcom'])
      .in('status', ['enviado', 'preparando'])
      .order('enviado_em', { ascending: true });
    if (error) throw error;

    const itens = (itensRaw ?? []).map((i: any) => ({
      item_id: i.id,
      order_id: i.order_id,
      numero_comanda: i.orders?.numero_comanda ?? i.order_id,
      mesa: i.orders?.mesas ? `Mesa ${i.orders.mesas.numero}${i.orders.mesas.nome ? ' - ' + i.orders.mesas.nome : ''}` : null,
      cliente_mesa_nome: i.orders?.cliente_mesa_nome ?? null,
      product_name: i.products?.name,
      quantity: i.quantity,
      status: i.status,
      enviado_em: i.enviado_em,
      preparando_em: i.preparando_em,
    }));

    // Três médias, sobre itens finalizados hoje: espera (na fila, antes do preparo
    // começar), preparo (tempo ativo de cozinha) e geral (soma das duas, o que o
    // cliente sente desde que pediu até ficar pronto).
    const inicioHoje = new Date();
    inicioHoje.setHours(0, 0, 0, 0);
    const { data: prontosHoje } = await this.supabase.client
      .from('order_items')
      .select('enviado_em, preparando_em, pronto_em, orders!inner(restaurant_id, canal)')
      .eq('orders.restaurant_id', restaurantId)
      .eq('orders.canal', 'presencial')
      .eq('status', 'pronto')
      .not('enviado_em', 'is', null)
      .not('preparando_em', 'is', null)
      .not('pronto_em', 'is', null)
      .gte('pronto_em', inicioHoje.toISOString())
      // Pedido enviado em dia anterior (ficou preso/esquecido) e só marcado pronto hoje
      // não é preparo "de hoje" — entraria como outlier gigante e mentiria a média.
      .gte('enviado_em', inicioHoje.toISOString());

    const media = (segundos: number[]) =>
      segundos.length ? Math.round(segundos.reduce((soma, s) => soma + s, 0) / segundos.length) : null;

    const esperas = (prontosHoje ?? []).map(
      (p: any) => (new Date(p.preparando_em).getTime() - new Date(p.enviado_em).getTime()) / 1000,
    );
    const preparos = (prontosHoje ?? []).map(
      (p: any) => (new Date(p.pronto_em).getTime() - new Date(p.preparando_em).getTime()) / 1000,
    );
    const gerais = (prontosHoje ?? []).map(
      (p: any) => (new Date(p.pronto_em).getTime() - new Date(p.enviado_em).getTime()) / 1000,
    );

    return {
      itens,
      tempoMedioEsperaSegundos: media(esperas),
      tempoMedioPreparoSegundos: media(preparos),
      tempoMedioGeralSegundos: media(gerais),
      amostras: (prontosHoje ?? []).length,
    };
  }

  async obterComanda(comandaId: number, garcomId: number) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: itens, error } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, unit_price, observacao, status, enviado_em, entregue_garcom, products(name, image_url)')
      .eq('order_id', comandaId)
      .order('id', { ascending: true });
    if (error) throw error;

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, valor, forma_pagamento, origem, criado_em, taxa_cartao_valor')
      .eq('order_id', comandaId)
      .order('criado_em', { ascending: true });
    const saldo = await this.saldoDevedor(comandaId);

    // Sugestão de gorjeta exibida pro garçom/cliente antes do fechamento — informativa,
    // o valor de fato lançado é o que o caixa confirma no PDV (pode ajustar).
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('gorjeta_percentual, taxa_cartao_percentual')
      .eq('id', comanda.restaurant_id)
      .maybeSingle();
    const percentual = restaurante?.gorjeta_percentual ?? 0;
    const subtotalItens = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const gorjeta_sugestao = { percentual, valor_sugerido: parseFloat(((subtotalItens * percentual) / 100).toFixed(2)) };
    const taxa_cartao_percentual = restaurante?.taxa_cartao_percentual ?? 0;

    return { ...comanda, itens, pagamentos: pagamentos ?? [], saldo, gorjeta_sugestao, taxa_cartao_percentual };
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

    await this.estoque.decrementarItens(itens);

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
  }

  private async garantirItemPendenteDoGarcom(comandaId: number, garcomId: number, itemId: number) {
    await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, status, product_id, quantity')
      .eq('id', itemId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');
    // Depois de enviado pro setor, só o estabelecimento (PDV) pode remover — o garçom
    // não edita/cancela mais nada que já foi impresso/pra fila de preparo.
    if (item.status !== 'pendente') throw new ForbiddenException('Item já foi enviado — só o estabelecimento pode alterar');
    return item;
  }

  async editarItem(comandaId: number, garcomId: number, itemId: number, body: { quantity?: number; observacao?: string }) {
    const item = await this.garantirItemPendenteDoGarcom(comandaId, garcomId, itemId);

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

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
  }

  // Observação pode ser editada/incluída mesmo depois do item já enviado pro setor —
  // diferente de quantidade/remoção (travadas após enviado), esquecer a observação é
  // erro comum do garçom e não deve exigir cancelar/reenviar o item inteiro.
  async editarObservacaoItem(comandaId: number, garcomId: number, itemId: number, observacao: string) {
    await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: item } = await this.supabase.client
      .from('order_items').select('id').eq('id', itemId).eq('order_id', comandaId).maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');

    const { error } = await this.supabase.client
      .from('order_items').update({ observacao: observacao?.trim() || null }).eq('id', itemId);
    if (error) throw error;

    return this.obterComanda(comandaId, garcomId);
  }

  async removerItem(comandaId: number, garcomId: number, itemId: number) {
    const item = await this.garantirItemPendenteDoGarcom(comandaId, garcomId, itemId);

    const { error } = await this.supabase.client.from('order_items').delete().eq('id', itemId);
    if (error) throw error;

    await this.estoque.restaurarItens([{ product_id: item.product_id, quantity: item.quantity }]);

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
  }

  // Separa itens escolhidos pra uma comanda avulsa nova — pro caso de um cliente da
  // mesa querer pagar só o que ele consumiu, sem mexer no resto da conta dos outros.
  // Não exige item "pendente" (diferente de editar/remover item) — separa pra cobrança
  // vale pra itens já enviados/prontos também, só muda quem paga por eles.
  async dividirComanda(comandaId: number, garcomId: number, itemIds: number[], clienteNome: string, clienteTelefone?: string) {
    if (!itemIds?.length) throw new BadRequestException('Selecione ao menos 1 item pra separar');
    if (!clienteNome?.trim()) throw new BadRequestException('Informe o nome do cliente da nova comanda');

    const origem = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (origem.status !== 'aberta') throw new BadRequestException('Só é possível dividir comandas abertas');

    const { data: itensOrigem } = await this.supabase.client
      .from('order_items').select('id').eq('order_id', comandaId);
    const idsValidos = new Set((itensOrigem ?? []).map((i: any) => i.id));
    const idsParaMover = [...new Set(itemIds)].filter((id) => idsValidos.has(id));
    if (!idsParaMover.length) throw new BadRequestException('Nenhum item válido selecionado');
    if (idsParaMover.length === idsValidos.size) {
      throw new BadRequestException('Selecione menos que todos os itens — pra mover a comanda inteira use transferir');
    }

    const { data: caixaAberto } = await this.supabase.client
      .from('caixas').select('id').eq('restaurant_id', origem.restaurant_id).eq('status', 'aberto').maybeSingle();

    const { data: novaComanda, error: errNova } = await this.supabase.client
      .from('orders')
      .insert({
        restaurant_id: origem.restaurant_id,
        canal: 'presencial',
        status: 'aberta',
        garcom_id: garcomId,
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
      .eq('order_id', comandaId)
      .in('id', idsParaMover);
    if (errMove) throw errMove;

    await this.recalcularTotal(comandaId);
    await this.recalcularTotal(novaComanda.id);

    return { ok: true, comanda_nova_id: novaComanda.id };
  }

  // Garçom confirma que levou o item até a mesa — a partir do momento que o Bar/Cozinha
  // já iniciou o preparo ('preparando' ou 'pronto', ver iniciarPreparoItem/marcarItemPronto
  // em restaurante.service.ts). Também força status pra 'pronto' se ainda tava 'preparando'
  // — garçom pode confirmar antes do Bar clicar o próprio "Entregue", e o item precisa sair
  // da fila ativa do Painel do Bar (senão fica preso lá achando que falta ação do Bar).
  // entregue_garcom é coluna própria, não mexe no status compartilhado com delivery.
  async confirmarEntregaItem(comandaId: number, garcomId: number, itemId: number) {
    await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, status, pronto_em')
      .eq('id', itemId)
      .eq('order_id', comandaId)
      .maybeSingle();
    if (!item) throw new NotFoundException('Item não encontrado');
    if (item.status !== 'preparando' && item.status !== 'pronto') {
      throw new ForbiddenException('Item ainda não está em preparo');
    }

    const agora = new Date().toISOString();
    const update: Record<string, unknown> = { entregue_garcom: true, entregue_em: agora };
    if (item.status === 'preparando') {
      update.status = 'pronto';
      update.pronto_em = item.pronto_em ?? agora;
    }

    const { error } = await this.supabase.client.from('order_items').update(update).eq('id', itemId);
    if (error) throw error;

    return this.obterComanda(comandaId, garcomId);
  }

  // Corrige nome/telefone do cliente digitados errado na abertura — o garçom só corrige
  // enquanto a comanda ainda tá com ele (não faz sentido depois de paga/cancelada).
  async editarClienteMesa(comandaId: number, garcomId: number, body: { cliente_nome: string; cliente_telefone: string }) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Só é possível editar comandas abertas ou aguardando pagamento');
    }
    if (!body.cliente_nome?.trim() || !body.cliente_telefone?.trim()) {
      throw new BadRequestException('Nome e telefone do cliente são obrigatórios');
    }

    const { error } = await this.supabase.client
      .from('orders')
      .update({ cliente_mesa_nome: body.cliente_nome.trim(), cliente_mesa_telefone: body.cliente_telefone.trim() })
      .eq('id', comandaId);
    if (error) throw error;

    return this.obterComanda(comandaId, garcomId);
  }

  // Garçom só exclui a própria comanda antes de mandar qualquer item pra cozinha — depois
  // disso é o estabelecimento que decide (cancelar via PDV), pra não sumir pedido em preparo.
  async excluirComanda(comandaId: number, garcomId: number) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (!['aberta', 'fechada_garcom'].includes(comanda.status)) {
      throw new BadRequestException('Comanda já foi paga ou cancelada');
    }

    const { data: itens } = await this.supabase.client
      .from('order_items').select('id, status, product_id, quantity').eq('order_id', comandaId);
    if ((itens ?? []).some((i: any) => i.status !== 'pendente')) {
      throw new BadRequestException('Só é possível excluir a comanda antes de enviar algum item pra cozinha');
    }

    const { error } = await this.supabase.client.from('orders').update({ status: 'canceled' }).eq('id', comandaId);
    if (error) throw error;

    if (itens?.length) await this.estoque.restaurarItens(itens);

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'livre' }).eq('id', comanda.mesa_id);
    }
    return { ok: true };
  }

  // Marcador seguro pra "negrito desligado" — o comando ESC/POS real (ESC E 0x00) tem um
  // byte NUL, que o Postgres TEXT não aceita (quebra o insert). Guardamos esse marcador no
  // banco e só trocamos pelo byte real em printers.py, na hora de mandar pra impressora.
  private static readonly MARCADOR_NEGRITO_OFF = '\x01BOLDOFF\x01';

  // Impressora térmica não usa a mesma codepage do texto enviado (cp850) — byte de acento
  // acaba sendo lido como início de caractere multi-byte, "comendo" a letra seguinte junto
  // (ex.: "Pão com Queijo" saía "P com Queijo"). Solução robusta e independente de firmware:
  // tira o acento antes de imprimir, garantindo ASCII puro em qualquer impressora.
  private removerAcentos(texto: string): string {
    return texto.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
  }

  formatarTicketTexto(
    setor: string,
    comanda: {
      mesas?: { numero: number; nome: string | null } | null;
      cliente_mesa_nome?: string | null;
      cliente_mesa_telefone?: string | null;
      garcons?: { nome: string } | null;
    },
    itens: { product_name?: string; quantity: number; description?: string | null; observacao?: string | null }[],
  ): string {
    // ESC/POS: fonte dupla (altura+largura) pra facilitar leitura em impressora térmica
    // (pedido de acessibilidade — usuário com baixa visão lê o ticket na cozinha/bar).
    // Nota: não dá pra mandar um byte 0x00 (reset de fonte) — Postgres TEXT não aceita
    // NUL embutido, o insert falha silenciosamente. Cada ticket novo já reinicializa a
    // impressora (ESC_INIT = ESC @) então não precisa resetar a fonte no fim deste.
    const ESC_INIT = '\x1b\x40';
    const FONTE_DUPLA = '\x1d\x21\x11';
    const NEGRITO_ON = '\x1b\x45\x01';
    const NEGRITO_OFF = SalaoService.MARCADOR_NEGRITO_OFF;

    const linhas: string[] = [];
    linhas.push(ESC_INIT + FONTE_DUPLA);
    linhas.push(this.removerAcentos(setor.toUpperCase()));
    if (comanda.mesas) {
      linhas.push(
        this.removerAcentos(`Mesa ${comanda.mesas.numero}${comanda.mesas.nome ? ' - ' + comanda.mesas.nome : ''}`),
      );
    }
    if (comanda.garcons?.nome) linhas.push(this.removerAcentos(`Garcom: ${comanda.garcons.nome}`));
    if (comanda.cliente_mesa_nome) linhas.push(this.removerAcentos(`Cliente: ${comanda.cliente_mesa_nome}`));
    if (comanda.cliente_mesa_telefone) linhas.push(`Whatsapp: ${comanda.cliente_mesa_telefone}`);
    linhas.push(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    linhas.push('--------------------------------');
    itens.forEach((item, idx) => {
      linhas.push(`${NEGRITO_ON}${this.removerAcentos(item.product_name ?? 'Produto')}${NEGRITO_OFF}`);
      linhas.push(`${NEGRITO_ON}Qtd: ${item.quantity}${NEGRITO_OFF}`);
      if (item.description) linhas.push(this.removerAcentos(`Descricao: ${item.description}`));
      if (item.observacao) linhas.push(this.removerAcentos(`Obs: ${item.observacao}`));
      if (idx < itens.length - 1) {
        linhas.push('');
        linhas.push('---------------');
      }
    });
    linhas.push('--------------------------------');
    return linhas.join('\n');
  }

  // Recibo do cliente (pagamento final / venda direta) — mesma ideia do ticket de setor,
  // mas com preço/subtotal/desconto/gorjeta/total/forma de pagamento, pra impressora
  // configurada em Config > "Impressora do recibo" (ver restaurante.service.ts).
  formatarReciboTexto(
    restauranteNome: string,
    comanda: {
      mesas?: { numero: number; nome: string | null } | null;
      mesa_id?: number | null;
      cliente_mesa_nome?: string | null;
    },
    itens: { product_name?: string; quantity: number; unit_price?: number }[],
    valores: {
      subtotal: number;
      desconto?: number;
      acrescimo?: number;
      gorjeta?: number;
      taxaCartao?: number;
      total: number;
      formaPagamento: string;
      trocoDado?: number;
    },
    pagamentos?: { valor: number; forma_pagamento: string; origem: string; taxa_cartao_valor?: number }[],
  ): string {
    const fmt = (v?: number) => (v ?? 0).toFixed(2).replace('.', ',');
    const PAGAMENTO_LABEL: Record<string, string> = { pix: 'PIX', credit_card: 'Cartao', debit_card: 'Debito', cash: 'Dinheiro' };
    const NEGRITO_ON = '\x1b\x45\x01';
    const NEGRITO_OFF = SalaoService.MARCADOR_NEGRITO_OFF;

    const linhas: string[] = [];
    linhas.push('\x1b\x40');
    linhas.push(this.removerAcentos(restauranteNome ?? 'RESTAURANTE'));
    linhas.push('RECIBO DE PAGAMENTO');
    linhas.push(comanda.mesa_id ? this.removerAcentos(`Mesa ${comanda.mesas?.numero ?? comanda.mesa_id}`) : 'Venda balcao');
    if (comanda.cliente_mesa_nome) linhas.push(this.removerAcentos(comanda.cliente_mesa_nome));
    linhas.push(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    linhas.push('--------------------------------');
    const LARGURA_LINHA = 32;
    for (const item of itens) {
      const qtd = `${item.quantity}x`.padEnd(4);
      const valorTxt = `R$ ${fmt((item.quantity ?? 0) * (item.unit_price ?? 0))}`;
      const espacoDesc = Math.max(LARGURA_LINHA - qtd.length - valorTxt.length, 1);
      const desc = this.removerAcentos(item.product_name ?? 'Produto').slice(0, espacoDesc).padEnd(espacoDesc);
      linhas.push(`${qtd}${desc}${valorTxt}`);
    }
    linhas.push('--------------------------------');
    linhas.push(`Subtotal: R$ ${fmt(valores.subtotal)}`);
    if (valores.desconto) linhas.push(`Desconto: - R$ ${fmt(valores.desconto)}`);
    if (valores.acrescimo) linhas.push(`Acrescimo: + R$ ${fmt(valores.acrescimo)}`);
    if (valores.gorjeta) linhas.push(`Gorjeta: R$ ${fmt(valores.gorjeta)}`);
    if (valores.taxaCartao) linhas.push(`Taxa cartao: + R$ ${fmt(valores.taxaCartao)}`);
    linhas.push(`${NEGRITO_ON}TOTAL: R$ ${fmt(valores.total)}${NEGRITO_OFF}`);
    if (pagamentos?.length) {
      linhas.push('--------------------------------');
      linhas.push('Pagamentos:');
      for (const p of pagamentos) {
        const origemLabel = p.origem === 'garcom' ? 'garcom' : 'caixa';
        const taxaP = p.taxa_cartao_valor ? ` + taxa R$ ${fmt(p.taxa_cartao_valor)}` : '';
        linhas.push(`${PAGAMENTO_LABEL[p.forma_pagamento] ?? p.forma_pagamento} (${origemLabel}): R$ ${fmt(p.valor + (p.taxa_cartao_valor ?? 0))}${taxaP}`);
      }
    } else {
      linhas.push(`Pagamento: ${PAGAMENTO_LABEL[valores.formaPagamento] ?? valores.formaPagamento}`);
    }
    if (valores.trocoDado) linhas.push(`Troco: R$ ${fmt(valores.trocoDado)}`);
    linhas.push('--------------------------------');
    linhas.push('Obrigado pela preferencia!');
    return linhas.join('\n');
  }

  // Imprime o recibo de venda na impressora configurada (Config > impressora do recibo)
  // se pareada com agente local; senão devolve os dados pro front cair no fallback do
  // navegador (printReciboCliente), como já acontecia antes dessa config existir.
  async imprimirReciboSeConfigurado(
    restaurantId: number,
    comanda: any,
    itens: { product_name?: string; quantity: number; unit_price?: number }[],
    valores: { subtotal: number; desconto?: number; acrescimo?: number; gorjeta?: number; taxaCartao?: number; total: number; formaPagamento: string; trocoDado?: number },
    pagamentos?: { valor: number; forma_pagamento: string; origem: string; taxa_cartao_valor?: number }[],
  ): Promise<{ via: 'agente' } | { via: 'navegador' }> {
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('name, recibo_impressora_id')
      .eq('id', restaurantId)
      .maybeSingle();
    const impressoraId = (restaurante as any)?.recibo_impressora_id;
    if (!impressoraId) return { via: 'navegador' };

    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, nome_sistema')
      .eq('id', impressoraId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!impressora?.nome_sistema) return { via: 'navegador' };

    const conteudo = this.formatarReciboTexto((restaurante as any)?.name, comanda, itens, valores, pagamentos);
    await this.supabase.client.from('impressao_jobs').insert({
      restaurant_id: restaurantId,
      impressora_id: impressoraId,
      conteudo,
    });
    return { via: 'agente' };
  }

  // Ticket de conferência pedido pelo caixa antes de fechar a conta — `valores` vem
  // preenchido com o que está na tela (desconto/acréscimo/gorjeta/taxa/forma). O
  // cliente (QR, sem login) só pode solicitar conferência, nunca gerar isso direto.
  formatarConferenciaTexto(
    restauranteNome: string,
    comanda: { mesas?: { numero: number; nome: string | null } | null; cliente_mesa_nome?: string | null; garcons?: { nome: string } | null },
    itens: { product_name?: string; quantity: number; unit_price?: number }[],
    valores: { desconto?: number; acrescimo?: number; gorjeta?: number; taxaCartao?: number; formaPagamento?: string },
    pagamentos?: { valor: number; forma_pagamento: string; origem: string; taxa_cartao_valor?: number }[],
  ): string {
    const fmt = (v?: number) => (v ?? 0).toFixed(2).replace('.', ',');
    const NEGRITO_ON = '\x1b\x45\x01';
    const NEGRITO_OFF = SalaoService.MARCADOR_NEGRITO_OFF;
    const PAGAMENTO_LABEL: Record<string, string> = { pix: 'PIX', credit_card: 'Cartao', debit_card: 'Debito', cash: 'Dinheiro' };

    const linhas: string[] = [];
    linhas.push('\x1b\x40');
    linhas.push(this.removerAcentos(restauranteNome ?? 'RESTAURANTE'));
    linhas.push('CONFERENCIA - NAO E RECIBO FISCAL');
    if (comanda.mesas) {
      linhas.push(this.removerAcentos(`Mesa ${comanda.mesas.numero}${comanda.mesas.nome ? ' - ' + comanda.mesas.nome : ''}`));
    }
    if (comanda.cliente_mesa_nome) linhas.push(this.removerAcentos(comanda.cliente_mesa_nome));
    if (comanda.garcons?.nome) linhas.push(this.removerAcentos(`Garcom: ${comanda.garcons.nome}`));
    linhas.push(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    linhas.push('--------------------------------');
    let subtotal = 0;
    for (const item of itens) {
      const totalItem = (item.quantity ?? 0) * (item.unit_price ?? 0);
      subtotal += totalItem;
      linhas.push(this.removerAcentos(`${item.quantity}x ${item.product_name ?? 'Produto'}`));
      linhas.push(`R$ ${fmt(totalItem)}`);
    }
    linhas.push('--------------------------------');
    const { desconto = 0, acrescimo = 0, gorjeta = 0, taxaCartao = 0, formaPagamento } = valores;
    const total = subtotal - desconto + acrescimo + gorjeta + taxaCartao;
    linhas.push(`Subtotal: R$ ${fmt(subtotal)}`);
    if (desconto) linhas.push(`Desconto: - R$ ${fmt(desconto)}`);
    if (acrescimo) linhas.push(`Acrescimo: + R$ ${fmt(acrescimo)}`);
    if (gorjeta) linhas.push(`Gorjeta: + R$ ${fmt(gorjeta)}`);
    if (taxaCartao) linhas.push(`Taxa cartao: + R$ ${fmt(taxaCartao)}`);
    linhas.push(`${NEGRITO_ON}TOTAL: R$ ${fmt(total)}${NEGRITO_OFF}`);
    if (pagamentos?.length) {
      linhas.push('--------------------------------');
      linhas.push('Ja pago:');
      for (const p of pagamentos) {
        const origemLabel = p.origem === 'garcom' ? 'garcom' : 'caixa';
        const taxaP = p.taxa_cartao_valor ? ` + taxa R$ ${fmt(p.taxa_cartao_valor)}` : '';
        linhas.push(`${PAGAMENTO_LABEL[p.forma_pagamento] ?? p.forma_pagamento} (${origemLabel}): R$ ${fmt(p.valor + (p.taxa_cartao_valor ?? 0))}${taxaP}`);
      }
    } else if (formaPagamento) {
      linhas.push(`Forma de pagamento: ${PAGAMENTO_LABEL[formaPagamento] ?? formaPagamento}`);
    }
    linhas.push('--------------------------------');
    linhas.push('Peca ao garcom pra fechar a conta');
    return linhas.join('\n');
  }

  // Cliente só pode SOLICITAR conferência (sem login, tela pública) — nunca mandar
  // nada pra impressão direto. Só marca o pedido; quem imprime de fato é o caixa,
  // via imprimirConferencia do PDV (que também limpa esse campo ao atender).
  async solicitarConferencia(token: string): Promise<{ ok: true } | { ok: false; motivo: 'nao_encontrada' }> {
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('id')
      .eq('tracking_token', token)
      .eq('canal', 'presencial')
      .in('status', ['aberta', 'fechada_garcom'])
      .maybeSingle();
    if (!comanda) return { ok: false, motivo: 'nao_encontrada' };

    const { error } = await this.supabase.client
      .from('orders')
      .update({ conferencia_solicitada_em: new Date().toISOString() })
      .eq('id', comanda.id)
      .is('conferencia_solicitada_em', null);
    if (error) throw error;
    return { ok: true };
  }

  async enviarItens(comandaId: number, garcomId: number) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    return this.processarEnvioPendentes(comandaId, comanda);
  }

  // Mesmo processamento de envio/impressão, chamado pelo lado do estabelecimento (PDV) quando
  // o dono/caixa inclui um item direto na comanda — não precisa do garçom "enviar" separado.
  async enviarItensComoRestaurante(comandaId: number, comanda: any) {
    return this.processarEnvioPendentes(comandaId, comanda);
  }

  private async processarEnvioPendentes(comandaId: number, comanda: any) {
    const { data: pendentes, error } = await this.supabase.client
      .from('order_items')
      .select('id, product_id, quantity, observacao, products(name, description, impressora_id, impressoras(id, nome, setor, nome_sistema))')
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

    const grupos = new Map<string, { setor: string; impressora_id: number | null; impressora_nome: string | null; nome_sistema: string | null; itens: any[] }>();
    for (const item of pendentes as any[]) {
      const impressora = item.products?.impressoras;
      const chave = impressora?.id ? String(impressora.id) : 'sem-impressora';
      if (!grupos.has(chave)) {
        grupos.set(chave, {
          setor: impressora?.setor ?? 'Sem setor',
          impressora_id: impressora?.id ?? null,
          impressora_nome: impressora?.nome ?? null,
          nome_sistema: impressora?.nome_sistema ?? null,
          itens: [],
        });
      }
      grupos.get(chave)!.itens.push({
        product_name: item.products?.name,
        description: item.products?.description,
        quantity: item.quantity,
        observacao: item.observacao,
      });
    }

    // Impressoras com agente local pareado (nome_sistema preenchido) viram um job de
    // impressão na fila — o agente Python puxa e imprime. As demais continuam caindo
    // no fallback de window.print() no navegador (grupos devolvidos pro frontend).
    const gruposParaNavegador: any[] = [];
    for (const grupo of grupos.values()) {
      if (grupo.nome_sistema && grupo.impressora_id) {
        const conteudo = this.formatarTicketTexto(grupo.setor, comanda as any, grupo.itens);
        const { error: errJob } = await this.supabase.client.from('impressao_jobs').insert({
          restaurant_id: comanda.restaurant_id,
          impressora_id: grupo.impressora_id,
          conteudo,
        });
        if (errJob) throw errJob;
      } else {
        gruposParaNavegador.push({ setor: grupo.setor, impressora_nome: grupo.impressora_nome, itens: grupo.itens });
      }
    }

    return { grupos: gruposParaNavegador };
  }

  // Reimpressão manual pedida na tela de KDS por setor — regera o ticket do grupo
  // (comanda + itens já enviados pra essa impressora) e reenvia pro mesmo destino
  // de sempre (fila do agente local ou fallback pro navegador).
  // Reimpressão por item (não por comanda inteira) — pedido explícito: cada prato tem
  // seu próprio ticket, imprimir de novo não deve reimprimir os outros itens da mesa junto.
  async reimprimirItem(itemId: number, restaurantId: number) {
    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, quantity, observacao, impressora_id, order_id, products(name, description), orders(id, restaurant_id, mesas(numero, nome), cliente_mesa_nome, cliente_mesa_telefone, garcons(nome))')
      .eq('id', itemId)
      .maybeSingle();
    if (!item || (item as any).orders?.restaurant_id !== restaurantId) {
      throw new NotFoundException('Item não encontrado');
    }
    if (!item.impressora_id) throw new BadRequestException('Item sem impressora associada');

    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, nome, setor, nome_sistema')
      .eq('id', item.impressora_id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!impressora) throw new NotFoundException('Impressora não encontrada');

    const itensFormatados = [{
      product_name: (item as any).products?.name,
      description: (item as any).products?.description,
      quantity: item.quantity,
      observacao: item.observacao,
    }];
    const conteudo = this.formatarTicketTexto((impressora as any).setor, (item as any).orders, itensFormatados);

    if ((impressora as any).nome_sistema) {
      const { error } = await this.supabase.client.from('impressao_jobs').insert({
        restaurant_id: restaurantId,
        impressora_id: item.impressora_id,
        conteudo,
      });
      if (error) throw error;
      return { ok: true, via: 'agente' };
    }

    return { ok: true, via: 'navegador', setor: (impressora as any).setor, impressora_nome: (impressora as any).nome, itens: itensFormatados };
  }

  // Garçom não escolhe mais a forma de pagamento aqui — quem define isso é o caixa,
  // no fechamento real da comanda (só ele emite recibo e finaliza o pagamento).
  async fecharComanda(comandaId: number, garcomId: number) {
    const comanda = await this.garantirComandaDoGarcom(comandaId, garcomId);
    if (comanda.status !== 'aberta') throw new BadRequestException('Comanda já foi fechada');

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('id, status, entregue_garcom')
      .eq('order_id', comandaId);
    if (!itens?.length) throw new BadRequestException('Comanda sem itens não pode ser fechada');

    const temEntregaPendente = itens.some((i) => ['preparando', 'pronto'].includes(i.status) && !i.entregue_garcom);
    if (temEntregaPendente) {
      throw new BadRequestException('Tem item pronto sem confirmar entrega: confirme a entrega antes de fechar a comanda');
    }

    // Garçom só entrega a comanda pro caixa depois de cobrar tudo do cliente na mesa —
    // gorjeta nesse momento é só estimativa (ainda não persistida), então só dá pra
    // validar aqui o saldo dos itens; a garantia da gorjeta fica por conta do frontend.
    const { saldo } = await this.saldoDevedor(comandaId);
    if (saldo > 0.01) {
      throw new BadRequestException('Saldo devedor pendente: registre os pagamentos até zerar o saldo antes de fechar a comanda');
    }

    const { error } = await this.supabase.client
      .from('orders')
      .update({ status: 'fechada_garcom' })
      .eq('id', comandaId);
    if (error) throw error;

    if (comanda.mesa_id) {
      await this.supabase.client.from('mesas').update({ status: 'aguardando_pagamento' }).eq('id', comanda.mesa_id);
    }

    return { ok: true };
  }
}

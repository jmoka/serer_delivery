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
      .select('id, mesa_id, garcom_id, cliente_mesa_nome, total')
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
      mesa: (comanda as any).mesas ? `Mesa ${(comanda as any).mesas.numero}` : null,
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
      .select('id, status, restaurant_id, mesa_id, garcom_id, numero_comanda, cliente_mesa_nome, cliente_mesa_telefone, mesas(numero, nome), garcons(nome)')
      .eq('id', comandaId)
      .eq('canal', 'presencial')
      .maybeSingle();
    if (!data) throw new NotFoundException('Comanda não encontrada');
    if (data.garcom_id !== garcomId) throw new ForbiddenException('Comanda não pertence a este garçom');
    return data;
  }

  // Saldo devedor considerando pagamentos parciais já registrados (garçom ou caixa).
  async saldoDevedor(comandaId: number) {
    const { data: itens } = await this.supabase.client.from('order_items').select('quantity, unit_price').eq('order_id', comandaId);
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('desconto_valor, acrescimo_valor')
      .eq('id', comandaId)
      .maybeSingle();
    const { data: pagamentos } = await this.supabase.client.from('comanda_pagamentos').select('valor').eq('order_id', comandaId);

    const subtotal = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const totalFinal = subtotal - (comanda?.desconto_valor ?? 0) + (comanda?.acrescimo_valor ?? 0);
    const totalPago = (pagamentos ?? []).reduce((acc: number, p: any) => acc + p.valor, 0);

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
  ) {
    if (!valor || valor <= 0) throw new BadRequestException('Valor precisa ser maior que zero');
    if (!formaPagamento) throw new BadRequestException('Informe a forma de pagamento');

    let troco: number | null = null;
    if (formaPagamento === 'cash' && valorRecebido !== undefined) {
      if (valorRecebido < valor) throw new BadRequestException('Valor recebido não pode ser menor que o valor a pagar');
      troco = parseFloat((valorRecebido - valor).toFixed(2));
    }

    const { error } = await this.supabase.client
      .from('comanda_pagamentos')
      .insert({ order_id: comandaId, valor, forma_pagamento: formaPagamento, origem, valor_recebido: valorRecebido ?? null, troco });
    if (error) throw error;

    if (troco && troco > 0) {
      await this.registrarSaidaCaixa(restaurantId, `Troco${identificador ? ` - ${identificador}` : ''}`, troco, 'troco');
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
    return this.registrarPagamento(comandaId, 'garcom', valor, formaPagamento, comanda.restaurant_id, valorRecebido, identificador);
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
      .select('id, mesa_id, cliente_mesa_nome, cliente_mesa_telefone, status, total, numero_comanda, created_at')
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

    const { data: pagamentos } = await this.supabase.client
      .from('comanda_pagamentos')
      .select('id, valor, forma_pagamento, origem, criado_em')
      .eq('order_id', comandaId)
      .order('criado_em', { ascending: true });
    const saldo = await this.saldoDevedor(comandaId);

    // Sugestão de gorjeta exibida pro garçom/cliente antes do fechamento — informativa,
    // o valor de fato lançado é o que o caixa confirma no PDV (pode ajustar).
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('gorjeta_percentual')
      .eq('id', comanda.restaurant_id)
      .maybeSingle();
    const percentual = restaurante?.gorjeta_percentual ?? 0;
    const subtotalItens = (itens ?? []).reduce((acc: number, i: any) => acc + i.quantity * i.unit_price, 0);
    const gorjeta_sugestao = { percentual, valor_sugerido: parseFloat(((subtotalItens * percentual) / 100).toFixed(2)) };

    return { ...comanda, itens, pagamentos: pagamentos ?? [], saldo, gorjeta_sugestao };
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

  private async garantirItemPendenteDoGarcom(comandaId: number, garcomId: number, itemId: number) {
    await this.garantirComandaDoGarcom(comandaId, garcomId);

    const { data: item } = await this.supabase.client
      .from('order_items')
      .select('id, status')
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
    await this.garantirItemPendenteDoGarcom(comandaId, garcomId, itemId);

    const update: Record<string, unknown> = {};
    if (body.quantity !== undefined) {
      if (body.quantity < 1) throw new BadRequestException('Quantidade mínima é 1');
      update.quantity = body.quantity;
    }
    if (body.observacao !== undefined) update.observacao = body.observacao?.trim() || null;

    const { error } = await this.supabase.client.from('order_items').update(update).eq('id', itemId);
    if (error) throw error;

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
  }

  async removerItem(comandaId: number, garcomId: number, itemId: number) {
    await this.garantirItemPendenteDoGarcom(comandaId, garcomId, itemId);

    const { error } = await this.supabase.client.from('order_items').delete().eq('id', itemId);
    if (error) throw error;

    await this.recalcularTotal(comandaId);
    return this.obterComanda(comandaId, garcomId);
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
    linhas.push(new Date().toLocaleString('pt-BR'));
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
  async reimprimirGrupo(orderId: number, impressoraId: number, restaurantId: number) {
    const { data: comanda } = await this.supabase.client
      .from('orders')
      .select('id, restaurant_id, mesas(numero, nome), cliente_mesa_nome, cliente_mesa_telefone, garcons(nome)')
      .eq('id', orderId)
      .maybeSingle();
    if (!comanda || (comanda as any).restaurant_id !== restaurantId) {
      throw new NotFoundException('Comanda não encontrada');
    }

    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, nome, setor, nome_sistema')
      .eq('id', impressoraId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!impressora) throw new NotFoundException('Impressora não encontrada');

    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('quantity, observacao, products(name, description)')
      .eq('order_id', orderId)
      .eq('impressora_id', impressoraId)
      .eq('status', 'enviado');
    if (!itens?.length) throw new BadRequestException('Nenhum item pendente desse setor pra reimprimir');

    const itensFormatados = itens.map((i: any) => ({
      product_name: i.products?.name,
      description: i.products?.description,
      quantity: i.quantity,
      observacao: i.observacao,
    }));
    const conteudo = this.formatarTicketTexto((impressora as any).setor, comanda as any, itensFormatados);

    if ((impressora as any).nome_sistema) {
      const { error } = await this.supabase.client.from('impressao_jobs').insert({
        restaurant_id: restaurantId,
        impressora_id: impressoraId,
        conteudo,
      });
      if (error) throw error;
      return { ok: true, via: 'agente' };
    }

    return { ok: true, via: 'navegador', setor: (impressora as any).setor, impressora_nome: (impressora as any).nome, itens: itensFormatados };
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

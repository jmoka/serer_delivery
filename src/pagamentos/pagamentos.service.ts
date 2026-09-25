import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PagBankClient } from './pagbank.client';
import { StripeService } from '../stripe/stripe.service';
import { PedidosService } from '../pedidos/pedidos.service';

const STATUS_PAGOS = ['PAID', 'COMPLETED', 'AVAILABLE'];

type SplitConfig = {
  sellerAccountId: string;
  platformAccountId: string;
  comissaoPct: number;
};

type ClienteInfo = {
  client: PagBankClient;
  webhookUrl: string;
  splitConfig?: SplitConfig;
};

@Injectable()
export class PagamentosService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private stripeService: StripeService,
    private pedidosService: PedidosService,
  ) {}

  private async buscarPedido(orderId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, restaurant_id, user_id, frete_cobrado, frete_excedente_cobrado')
      .eq('id', orderId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Pedido ${orderId} não encontrado`);
    return data;
  }

  // customer.phones passou a ser exigido pela PagBank na Orders API (Pix v2,
  // reference/criar-pedido-com-qr-code-pix-v2) — busca o telefone salvo do
  // cliente e converte do formato E.164 (+5511999998888) pro formato
  // country/area/number que a PagBank espera. Sem telefone salvo, retorna
  // undefined (omite o campo em vez de inventar um número).
  private async buscarTelefonePagBank(userId: string) {
    const { data } = await this.supabase.client
      .from('customers')
      .select('phone_e164')
      .eq('user_id', userId)
      .maybeSingle();

    const digitos = (data?.phone_e164 ?? '').replace(/\D/g, '');
    // +55 (2) + DDD (2) + número (8 ou 9) = 12 ou 13 dígitos total
    if (digitos.length < 12) return undefined;

    return [{
      country: digitos.slice(0, 2),
      area: digitos.slice(2, 4),
      number: digitos.slice(4),
      type: 'MOBILE' as const,
    }];
  }

  private async getPagBankClient(restaurantId: number): Promise<ClienteInfo> {
    // Busca config do restaurante e config global da plataforma em paralelo
    const [{ data: restData }, { data: platData }] = await Promise.all([
      this.supabase.client
        .from('restaurants')
        .select('payment_config, comissao_pct')
        .eq('id', restaurantId)
        .maybeSingle(),
      this.supabase.client
        .from('platform_settings')
        .select('config')
        .eq('id', 1)
        .maybeSingle(),
    ]);

    const cfg = (restData?.payment_config ?? {}) as Record<string, any>;
    const platCfg = (platData?.config ?? {}) as Record<string, any>;
    const comissaoPct: number = restData?.comissao_pct ?? platCfg.comissao_padrao_pct ?? 5;

    // Platform token: DB tem prioridade sobre .env
    const platformToken =
      platCfg.pagbank_platform_token ||
      this.config.get<string>('PAGBANK_PLATFORM_TOKEN') ||
      '';
    const platformAccountId =
      platCfg.pagbank_platform_account_id ||
      this.config.get<string>('PAGBANK_PLATFORM_ACCOUNT_ID') ||
      '';
    const sellerAccountId: string = cfg.pagbank_seller_account_id ?? '';

    const sandbox =
      platCfg.pagbank_sandbox ??
      (cfg.pagbank_sandbox !== undefined
        ? cfg.pagbank_sandbox
        : this.config.get('PAGBANK_SANDBOX') !== 'false');

    const webhookUrl =
      cfg.pagbank_webhook_url ||
      this.config.get('PAGBANK_WEBHOOK_URL') ||
      'http://localhost:3002/pagamentos/webhook';

    // Kill-switch do admin (não apaga token/account_id/contas de ninguém) — liga/desliga
    // em /admin/configuracoes. Usado quando a PagBank bloqueia split ("whitelist access
    // required") sem afetar homologação de token/conta ainda válida pro fluxo sem split.
    const splitHabilitado = platCfg.pagbank_split_habilitado ?? true;

    // Split habilitado: plataforma tem token + ambas as contas configuradas
    if (splitHabilitado && platformToken && platformAccountId && sellerAccountId) {
      return {
        client: new PagBankClient(platformToken, sandbox),
        webhookUrl,
        splitConfig: { sellerAccountId, platformAccountId, comissaoPct },
      };
    }

    // Fallback: token próprio do restaurante (sem split automático)
    const token = cfg.pagbank_token || this.config.get('PAGBANK_TOKEN') || '';
    return { client: new PagBankClient(token, sandbox), webhookUrl };
  }

  // Calcula splits em centavos: vendedor recebe (100 - comissao)%, plataforma recebe comissao%.
  // Formato exato exigido pela PagBank: objeto único (não array), fica dentro de
  // charges[0].splits — não na raiz do pedido (raiz aceita qualquer campo desconhecido
  // sem erro, então um split mal posicionado nunca falha, só é ignorado em silêncio).
  //
  // freteCentavos (frete_cobrado + frete_excedente_cobrado) fica FORA da base de cálculo
  // da comissão — a plataforma cobra % só da venda do produto, nunca do frete, que é
  // 100% repasse pro motoboy (mesmo quando embutido no preço, ver frete_embutido). Ainda
  // assim soma no sellerAmount igual antes: o valor total splitado continua batendo com
  // valorCentavos, só a fatia que vai pra plataforma que fica menor.
  private buildSplits(valorCentavos: number, freteCentavos: number, split: SplitConfig) {
    const baseComissao = Math.max(0, valorCentavos - freteCentavos);
    const adminAmount = Math.round(baseComissao * split.comissaoPct / 100);
    const sellerAmount = valorCentavos - adminAmount; // resto para evitar erro de arredondamento

    return {
      method: 'FIXED' as const,
      receivers: [
        { account: { id: split.sellerAccountId }, amount: { value: sellerAmount } },
        { account: { id: split.platformAccountId }, amount: { value: adminAmount } },
      ],
    };
  }

  private limparCpf(cpf: string) {
    return cpf.replace(/\D/g, '');
  }

  // Chave pública pro PagBank.js criptografar o cartão no navegador do cliente
  // (checkout) — diferente da de faturas (planos.service.ts), que usa o token
  // da plataforma; aqui usa o token do restaurante que está vendendo.
  async buscarChavePublicaCartao(restaurantId: number) {
    const { client } = await this.getPagBankClient(restaurantId);
    try {
      const resposta = await client.buscarChavePublica();
      return { public_key: resposta.public_key };
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao obter chave pública do PagBank');
    }
  }

  async criarPix(body: {
    order_id: number;
    customer: { name: string; email: string; tax_id: string };
  }, callerUserId: string) {
    const pedido = await this.buscarPedido(body.order_id);
    if (pedido.user_id !== callerUserId) {
      throw new ForbiddenException('Este pedido não pertence a você');
    }

    if (pedido.status !== 'pending') {
      throw new BadRequestException('Pedido não está pendente de pagamento');
    }

    const valorCentavos = Math.round(pedido.total * 100);
    const freteCentavos = Math.round(((pedido.frete_cobrado ?? 0) + (pedido.frete_excedente_cobrado ?? 0)) * 100);
    const refId = `DELIVERY_${pedido.id}_${Date.now()}`;
    const { client: pagbank, webhookUrl, splitConfig } = await this.getPagBankClient(pedido.restaurant_id);

    const splits = splitConfig ? this.buildSplits(valorCentavos, freteCentavos, splitConfig) : undefined;
    const phones = await this.buscarTelefonePagBank(callerUserId);

    let resposta: any;
    try {
      resposta = await pagbank.criarOrdemPix({
        reference_id: refId,
        valor_centavos: valorCentavos,
        customer: {
          name: body.customer.name,
          email: body.customer.email,
          tax_id: this.limparCpf(body.customer.tax_id),
          phones,
        },
        itens: [{ name: `Pedido #${pedido.id}`, quantity: 1, unit_amount: valorCentavos }],
        webhook_url: webhookUrl,
        splits,
      });
    } catch (e: any) {
      // Erro cru da PagBank (Error simples, não HttpException) viraria 500 genérico
      // sem detalhe nenhum pro cliente — converte pra 400 com a mensagem real.
      throw new BadRequestException(e?.message ?? 'Falha ao gerar o PIX na PagBank');
    }

    // Pix v2: QR code agora vem em charges[0].qr_code (antes era qr_codes[] solto
    // na ordem) — ver reference/criar-pedido-com-qr-code-pix-v2.
    const charge = resposta?.charges?.[0];
    const pixCode = charge?.qr_code?.text ?? null;
    const pixQrUrl = charge?.links?.find((l: any) => l.rel === 'QRCODE.PNG')?.href ?? null;

    const { data: pagamento, error } = await this.supabase.client
      .from('pagamentos')
      .insert({
        order_id: pedido.id,
        pagbank_order_id: resposta.id,
        tipo: 'pix',
        status: 'pending',
        valor: pedido.total,
        pix_code: pixCode,
        pix_qr_url: pixQrUrl,
        split_ativo: !!splitConfig,
      })
      .select()
      .single();

    if (error) throw error;

    return {
      pagamento_id: pagamento.id,
      pix_code: pixCode,
      pix_qr_url: pixQrUrl,
      pagbank_order_id: resposta.id,
      split_ativo: !!splitConfig,
      expira_em: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async criarCartao(body: {
    order_id: number;
    customer: { name: string; email: string; tax_id: string };
    card_encrypted: string;
    parcelas?: number;
    tipo?: 'CREDIT_CARD' | 'DEBIT_CARD';
  }, callerUserId: string) {
    const pedido = await this.buscarPedido(body.order_id);
    if (pedido.user_id !== callerUserId) {
      throw new ForbiddenException('Este pedido não pertence a você');
    }

    if (pedido.status !== 'pending') {
      throw new BadRequestException('Pedido não está pendente de pagamento');
    }

    const valorCentavos = Math.round(pedido.total * 100);
    const freteCentavos = Math.round(((pedido.frete_cobrado ?? 0) + (pedido.frete_excedente_cobrado ?? 0)) * 100);
    const refId = `DELIVERY_${pedido.id}_${Date.now()}`;
    const tipo = body.tipo ?? 'CREDIT_CARD';
    const { client: pagbank, webhookUrl, splitConfig } = await this.getPagBankClient(pedido.restaurant_id);

    const splits = splitConfig ? this.buildSplits(valorCentavos, freteCentavos, splitConfig) : undefined;
    const phones = await this.buscarTelefonePagBank(callerUserId);

    let resposta: any;
    try {
      resposta = await pagbank.criarOrdemCartao({
        reference_id: refId,
        valor_centavos: valorCentavos,
        customer: {
          name: body.customer.name,
          email: body.customer.email,
          tax_id: this.limparCpf(body.customer.tax_id),
          phones,
        },
        itens: [{ name: `Pedido #${pedido.id}`, quantity: 1, unit_amount: valorCentavos }],
        card_encrypted: body.card_encrypted,
        parcelas: body.parcelas ?? 1,
        tipo,
        webhook_url: webhookUrl,
        splits,
      });
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao processar o cartão na PagBank');
    }

    const charge = resposta?.charges?.[0];
    const statusPagamento = STATUS_PAGOS.includes(charge?.status) ? 'paid' : 'pending';

    const { data: pagamento, error } = await this.supabase.client
      .from('pagamentos')
      .insert({
        order_id: pedido.id,
        pagbank_order_id: resposta.id,
        pagbank_charge_id: charge?.id ?? null,
        tipo: tipo === 'CREDIT_CARD' ? 'credit_card' : 'debit_card',
        status: statusPagamento,
        valor: pedido.total,
        pago_em: statusPagamento === 'paid' ? new Date().toISOString() : null,
        split_ativo: !!splitConfig,
      })
      .select()
      .single();

    if (error) throw error;

    if (statusPagamento === 'paid') {
      await this.pedidosService.confirmarPagamento(pedido.id);
    }

    return {
      pagamento_id: pagamento.id,
      status: statusPagamento,
      pagbank_order_id: resposta.id,
      charge_id: charge?.id,
      split_ativo: !!splitConfig,
    };
  }

  async criarStripe(body: { order_id: number }, callerUserId: string) {
    const pedido = await this.buscarPedido(body.order_id);
    if (pedido.user_id !== callerUserId) {
      throw new ForbiddenException('Este pedido não pertence a você');
    }
    if (pedido.status !== 'pending') {
      throw new BadRequestException('Pedido não está pendente de pagamento');
    }

    const { client_secret, payment_intent_id } = await this.stripeService.criarPaymentIntent({
      restaurantId: pedido.restaurant_id,
      orderId: pedido.id,
      valorReais: pedido.total,
      freteReais: (pedido.frete_cobrado ?? 0) + (pedido.frete_excedente_cobrado ?? 0),
    });

    const { data: pagamento, error } = await this.supabase.client
      .from('pagamentos')
      .insert({
        order_id: pedido.id,
        gateway: 'stripe',
        stripe_payment_intent_id: payment_intent_id,
        tipo: 'credit_card',
        status: 'pending',
        valor: pedido.total,
        split_ativo: true,
      })
      .select()
      .single();

    if (error) throw error;

    return { pagamento_id: pagamento.id, client_secret };
  }

  async buscarPorPedido(orderId: number, callerUserId: string, callerRole: string) {
    const pedido = await this.buscarPedido(orderId);
    if (callerRole !== 'admin' && pedido.user_id !== callerUserId) {
      throw new ForbiddenException('Você não tem acesso a este pedido');
    }

    const { data, error } = await this.supabase.client
      .from('pagamentos')
      .select('id, tipo, status, valor, pix_code, pix_qr_url, pagbank_order_id, pago_em, criado_em, split_ativo')
      .eq('order_id', orderId)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    return { pagamentos: data ?? [] };
  }

  // Tela do estabelecimento: quanto entrou, quanto a Stripe/plataforma reteve e quanto
  // efetivamente cai na conta da loja — sem a tarifa da Stripe (esse custo é da
  // plataforma, não afeta o valor que a loja recebe, ver processarPaymentIntent).
  async listarStripeRestaurante(restaurantId: number, opts: { page?: number; limit?: number } = {}) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 50;

    const { data, error, count } = await this.supabase.client
      .from('pagamentos')
      .select('id, order_id, valor, comissao_valor, valor_liquido_loja, status, repasse_em, pago_em, criado_em, orders!inner(restaurant_id)', { count: 'exact' })
      .eq('gateway', 'stripe')
      .eq('orders.restaurant_id', restaurantId)
      .order('criado_em', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    return {
      pagamentos: (data ?? []).map((p: any) => ({
        id: p.id,
        order_id: p.order_id,
        valor: p.valor,
        comissao_valor: p.comissao_valor,
        valor_liquido: p.valor_liquido_loja,
        status: p.status,
        repasse_em: p.repasse_em,
        pago_em: p.pago_em,
        criado_em: p.criado_em,
      })),
      total: count ?? 0,
      page,
      limit,
    };
  }

  // Mesma tela pro admin, olhando qualquer loja — aqui sim entra a tarifa da Stripe,
  // pra dar pra ver a margem líquida real da plataforma (comissao_valor - stripe_taxa_valor).
  async listarStripeAdmin(opts: { restaurantId?: number; page?: number; limit?: number } = {}) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 50;

    let query = this.supabase.client
      .from('pagamentos')
      .select(
        'id, order_id, valor, comissao_valor, stripe_taxa_valor, valor_liquido_loja, status, repasse_em, pago_em, criado_em, orders!inner(restaurant_id, restaurants(name))',
        { count: 'exact' },
      )
      .eq('gateway', 'stripe')
      .order('criado_em', { ascending: false });

    if (opts.restaurantId) query = query.eq('orders.restaurant_id', opts.restaurantId);

    const { data, error, count } = await query.range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    return {
      pagamentos: (data ?? []).map((p: any) => ({
        id: p.id,
        order_id: p.order_id,
        restaurant_id: p.orders?.restaurant_id,
        restaurante_nome: p.orders?.restaurants?.name,
        valor: p.valor,
        comissao_valor: p.comissao_valor,
        stripe_taxa_valor: p.stripe_taxa_valor,
        margem_liquida_plataforma: p.comissao_valor != null && p.stripe_taxa_valor != null ? p.comissao_valor - p.stripe_taxa_valor : null,
        valor_liquido_loja: p.valor_liquido_loja,
        status: p.status,
        repasse_em: p.repasse_em,
        pago_em: p.pago_em,
        criado_em: p.criado_em,
      })),
      total: count ?? 0,
      page,
      limit,
    };
  }

  async processarWebhook(evento: any) {
    const payload = evento?.data ?? evento;
    const pagbankOrderId: string = payload?.id ?? payload?.reference_id;
    if (!pagbankOrderId) return { ignorado: true };

    const { data: pagamento } = await this.supabase.client
      .from('pagamentos')
      .select('id, order_id, status')
      .eq('pagbank_order_id', pagbankOrderId)
      .maybeSingle();

    if (!pagamento) return { ignorado: true, motivo: 'pagamento não encontrado' };
    if (pagamento.status === 'paid') return { ignorado: true, motivo: 'já processado' };

    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('restaurant_id')
      .eq('id', pagamento.order_id)
      .maybeSingle();
    if (!pedido) return { ignorado: true, motivo: 'pedido não encontrado' };

    // PagBank não assina notificações — nunca confiar no status vindo no corpo
    // do POST. Reconsulta a ordem direto na API do PagBank e decide a partir
    // dessa resposta autoritativa (evita marcar "pago" via webhook forjado).
    const { client } = await this.getPagBankClient(pedido.restaurant_id);
    const ordemReal = await client.buscarOrdem(pagbankOrderId);
    const detalhe = ordemReal?.charges?.[0] ?? ordemReal?.payments?.[0];
    if (!detalhe) return { ignorado: true };

    const statusPagbank: string = detalhe?.status ?? '';
    const pago = STATUS_PAGOS.includes(statusPagbank);

    const novoStatus = pago ? 'paid' : statusPagbank === 'DECLINED' ? 'declined' : pagamento.status;

    await this.supabase.client
      .from('pagamentos')
      .update({
        status: novoStatus,
        pagbank_charge_id: detalhe?.id ?? null,
        pago_em: pago ? new Date().toISOString() : null,
        webhook_recebido_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', pagamento.id);

    if (pago) {
      await this.pedidosService.confirmarPagamento(pagamento.order_id);
    }

    return { processado: true, status: novoStatus, order_id: pagamento.order_id };
  }
}

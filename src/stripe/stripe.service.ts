import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { SupabaseService } from '../supabase/supabase.service';
import { PedidosService } from '../pedidos/pedidos.service';

@Injectable()
export class StripeService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private pedidosService: PedidosService,
  ) {}

  // Chave é da PLATAFORMA (uma só, nunca por restaurante) — DB tem
  // prioridade sobre .env, mesma regra do token Marketplace do PagBank,
  // pra o admin poder trocar pelo painel sem mexer em arquivo/reiniciar.
  private async getPlatformConfig() {
    const { data } = await this.supabase.client
      .from('platform_settings')
      .select('config')
      .eq('id', 1)
      .maybeSingle();
    return (data?.config ?? {}) as Record<string, any>;
  }

  private async getClient(): Promise<Stripe> {
    const cfg = await this.getPlatformConfig();
    const chave = cfg.stripe_secret_key || this.config.get<string>('STRIPE_SECRET_KEY');
    if (!chave) throw new BadRequestException('Stripe não configurado nesta plataforma');
    return new Stripe(chave);
  }

  private async getWebhookSecret(): Promise<string> {
    const cfg = await this.getPlatformConfig();
    return cfg.stripe_webhook_secret || this.config.get<string>('STRIPE_WEBHOOK_SECRET') || '';
  }

  // Endpoint SEPARADO (escopo "Contas conectadas" no dashboard Stripe) — payout.paid
  // chega assinado com um segredo diferente do endpoint normal (escopo "Sua conta").
  private async getConnectWebhookSecret(): Promise<string> {
    const cfg = await this.getPlatformConfig();
    return cfg.stripe_connect_webhook_secret || this.config.get<string>('STRIPE_CONNECT_WEBHOOK_SECRET') || '';
  }

  private statusDaConta(conta: Stripe.Account): 'ativo' | 'em_verificacao' | 'pendente' {
    if (conta.charges_enabled && conta.payouts_enabled) return 'ativo';
    if (conta.details_submitted) return 'em_verificacao';
    return 'pendente';
  }

  private async persistirFlags(restaurantId: number, conta: Stripe.Account) {
    const { data: atual } = await this.supabase.client
      .from('restaurants')
      .select('payment_config')
      .eq('id', restaurantId)
      .maybeSingle();

    const cfg = (atual?.payment_config ?? {}) as Record<string, any>;
    const novo = {
      ...cfg,
      stripe_charges_enabled: !!conta.charges_enabled,
      stripe_payouts_enabled: !!conta.payouts_enabled,
      stripe_details_submitted: !!conta.details_submitted,
    };

    await this.supabase.client
      .from('restaurants')
      .update({ payment_config: novo, updated_at: new Date().toISOString() })
      .eq('id', restaurantId);
  }

  async gerarLinkOnboarding(restaurantId: number, origem: string) {
    const client = await this.getClient();

    const { data: restaurante, error } = await this.supabase.client
      .from('restaurants')
      .select('id, name, email, stripe_account_id')
      .eq('id', restaurantId)
      .maybeSingle();

    if (error) throw error;
    if (!restaurante) throw new BadRequestException('Restaurante não encontrado');

    let accountId = restaurante.stripe_account_id;

    if (!accountId) {
      const conta = await client.accounts.create({
        type: 'express',
        country: 'BR',
        email: restaurante.email || undefined,
        business_type: 'individual',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = conta.id;

      const { error: updError } = await this.supabase.client
        .from('restaurants')
        .update({ stripe_account_id: accountId, updated_at: new Date().toISOString() })
        .eq('id', restaurantId);
      if (updError) throw updError;
    }

    const base = origem.replace(/\/$/, '');
    const link = await client.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/restaurante/config?stripe=refresh`,
      return_url: `${base}/restaurante/config?stripe=return`,
      type: 'account_onboarding',
    });

    return { url: link.url };
  }

  async status(restaurantId: number) {
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('stripe_account_id')
      .eq('id', restaurantId)
      .maybeSingle();

    if (!restaurante?.stripe_account_id) {
      return {
        conectado: false,
        status: 'nao_conectado' as const,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      };
    }

    const client = await this.getClient();
    const conta = await client.accounts.retrieve(restaurante.stripe_account_id);
    await this.persistirFlags(restaurantId, conta);

    return {
      conectado: true,
      status: this.statusDaConta(conta),
      charges_enabled: !!conta.charges_enabled,
      payouts_enabled: !!conta.payouts_enabled,
      details_submitted: !!conta.details_submitted,
    };
  }

  // account.updated do webhook — a Stripe já manda a conta autoritativa no
  // próprio evento assinado, não precisa reconsultar a API (diferente do
  // PagBank, que não assina e por isso exige reconsulta).
  async sincronizarConta(conta: Stripe.Account) {
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('id')
      .eq('stripe_account_id', conta.id)
      .maybeSingle();

    if (!restaurante) return;
    await this.persistirFlags(restaurante.id, conta);
  }

  async construirEvento(payload: Buffer, assinatura: string): Promise<Stripe.Event> {
    const [client, webhookSecret] = await Promise.all([this.getClient(), this.getWebhookSecret()]);
    if (!webhookSecret) throw new BadRequestException('Webhook do Stripe não configurado');
    return client.webhooks.constructEvent(payload, assinatura, webhookSecret);
  }

  async construirEventoConnect(payload: Buffer, assinatura: string): Promise<Stripe.Event> {
    const [client, webhookSecret] = await Promise.all([this.getClient(), this.getConnectWebhookSecret()]);
    if (!webhookSecret) throw new BadRequestException('Webhook Connect do Stripe não configurado');
    return client.webhooks.constructEvent(payload, assinatura, webhookSecret);
  }

  // Cobrança do cliente — destination charge: o PaymentIntent vive na conta da
  // PLATAFORMA (por isso não usa Stripe-Account header), o valor líquido é
  // transferido pra conta conectada da loja (transfer_data.destination) e a
  // comissão fica retida automaticamente via application_fee_amount — mesmo
  // resultado do split do PagBank, só que resolvido pela própria Stripe.
  async criarPaymentIntent(params: { restaurantId: number; orderId: number; valorReais: number }) {
    const client = await this.getClient();

    const [{ data: restaurante }, { data: plat }] = await Promise.all([
      this.supabase.client
        .from('restaurants')
        .select('stripe_account_id, comissao_pct, payment_config')
        .eq('id', params.restaurantId)
        .maybeSingle(),
      this.supabase.client.from('platform_settings').select('config').eq('id', 1).maybeSingle(),
    ]);

    if (!restaurante?.stripe_account_id) {
      throw new BadRequestException('Restaurante não conectou uma conta Stripe');
    }
    if (!restaurante.payment_config?.stripe_charges_enabled) {
      throw new BadRequestException('Conta Stripe do restaurante ainda não está ativa para receber pagamentos');
    }

    const comissaoPct: number = restaurante.comissao_pct ?? (plat?.config as any)?.comissao_padrao_pct ?? 5;
    const valorCentavos = Math.round(params.valorReais * 100);
    const taxaCentavos = Math.round(valorCentavos * comissaoPct / 100);

    const intent = await client.paymentIntents.create({
      amount: valorCentavos,
      currency: 'brl',
      payment_method_types: ['card'],
      application_fee_amount: taxaCentavos,
      transfer_data: { destination: restaurante.stripe_account_id },
      metadata: { order_id: String(params.orderId) },
    });

    return { client_secret: intent.client_secret, payment_intent_id: intent.id };
  }

  // payment_intent.* do webhook — assinado pela própria Stripe, então (diferente
  // do PagBank) dá pra confiar direto no status do evento sem reconsultar a API.
  async processarPaymentIntent(intent: Stripe.PaymentIntent) {
    const { data: pagamento } = await this.supabase.client
      .from('pagamentos')
      .select('id, order_id, status')
      .eq('stripe_payment_intent_id', intent.id)
      .maybeSingle();

    if (!pagamento || pagamento.status === 'paid') return;

    const pago = intent.status === 'succeeded';
    const novoStatus = pago ? 'paid' : intent.status === 'canceled' ? 'declined' : pagamento.status;

    // Dados de conferência (tarifa Stripe, comissão retida, valor líquido que a loja
    // recebe) só dão pra buscar depois do pagamento — o intent do próprio evento não
    // vem com o balance_transaction expandido, precisa buscar o charge à parte.
    let dadosFinanceiros: Record<string, any> = {};
    if (pago) {
      const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : (intent.latest_charge as any)?.id;
      if (chargeId) {
        const client = await this.getClient();
        const charge = await client.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
        const bt = charge.balance_transaction as Stripe.BalanceTransaction | null;
        const transferId = typeof charge.transfer === 'string' ? charge.transfer : (charge.transfer as any)?.id ?? null;
        dadosFinanceiros = {
          stripe_transfer_id: transferId,
          stripe_taxa_valor: bt ? bt.fee / 100 : null,
          comissao_valor: intent.application_fee_amount != null ? intent.application_fee_amount / 100 : null,
          valor_liquido_loja: intent.application_fee_amount != null ? (intent.amount - intent.application_fee_amount) / 100 : null,
        };
      }
    }

    await this.supabase.client
      .from('pagamentos')
      .update({
        status: novoStatus,
        pago_em: pago ? new Date().toISOString() : null,
        webhook_recebido_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
        ...dadosFinanceiros,
      })
      .eq('id', pagamento.id);

    if (pago) {
      await this.pedidosService.confirmarPagamento(pagamento.order_id);
    }
  }

  // payout.paid do webhook Connect (evento da conta CONECTADA, não da plataforma —
  // precisa do endpoint configurado no dashboard Stripe pra "escutar eventos de contas
  // conectadas"). Um payout agrupa vários repasses de uma vez só; balanceTransactions
  // com o filtro `payout` devolve exatamente as transferências (`type: 'transfer'`)
  // incluídas nesse payout, e `source` de cada uma é o ID do Transfer — o mesmo que
  // já gravamos em pagamentos.stripe_transfer_id no momento do pagamento.
  async processarPayout(payout: Stripe.Payout, contaConectadaId: string | undefined) {
    if (!contaConectadaId) return;
    const client = await this.getClient();

    const transferIds: string[] = [];
    let startingAfter: string | undefined;
    do {
      const pagina = await client.balanceTransactions.list(
        { payout: payout.id, limit: 100, starting_after: startingAfter },
        { stripeAccount: contaConectadaId },
      );
      for (const t of pagina.data) {
        if (t.type === 'transfer' && typeof t.source === 'string') transferIds.push(t.source);
      }
      startingAfter = pagina.has_more ? pagina.data[pagina.data.length - 1]?.id : undefined;
    } while (startingAfter);

    if (!transferIds.length) return;

    await this.supabase.client
      .from('pagamentos')
      .update({ stripe_payout_id: payout.id, repasse_em: new Date().toISOString() })
      .in('stripe_transfer_id', transferIds)
      .is('repasse_em', null);
  }
}

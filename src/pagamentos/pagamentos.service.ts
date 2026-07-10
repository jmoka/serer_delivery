import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PagBankClient } from './pagbank.client';

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
  ) {}

  private async buscarPedido(orderId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, restaurant_id, user_id')
      .eq('id', orderId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Pedido ${orderId} não encontrado`);
    return data;
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
    const comissaoPct: number = restData?.comissao_pct ?? 5;

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

    // Split habilitado: plataforma tem token + ambas as contas configuradas
    if (platformToken && platformAccountId && sellerAccountId) {
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

  // Calcula splits em centavos: vendedor recebe (100 - comissao)%, plataforma recebe comissao%
  private buildSplits(valorCentavos: number, split: SplitConfig) {
    const adminAmount = Math.round(valorCentavos * split.comissaoPct / 100);
    const sellerAmount = valorCentavos - adminAmount; // resto para evitar erro de arredondamento

    return [{
      method: 'FIXED' as const,
      receivers: [
        { account: { id: split.sellerAccountId }, amount: { value: sellerAmount } },
        { account: { id: split.platformAccountId }, amount: { value: adminAmount } },
      ],
    }];
  }

  private limparCpf(cpf: string) {
    return cpf.replace(/\D/g, '');
  }

  async criarPix(body: {
    order_id: number;
    customer: { name: string; email: string; tax_id: string };
  }) {
    const pedido = await this.buscarPedido(body.order_id);

    if (pedido.status !== 'pending') {
      throw new BadRequestException('Pedido não está pendente de pagamento');
    }

    const valorCentavos = Math.round(pedido.total * 100);
    const refId = `DELIVERY_${pedido.id}_${Date.now()}`;
    const { client: pagbank, webhookUrl, splitConfig } = await this.getPagBankClient(pedido.restaurant_id);

    const splits = splitConfig ? this.buildSplits(valorCentavos, splitConfig) : undefined;

    const resposta = await pagbank.criarOrdemPix({
      reference_id: refId,
      valor_centavos: valorCentavos,
      customer: {
        name: body.customer.name,
        email: body.customer.email,
        tax_id: this.limparCpf(body.customer.tax_id),
      },
      itens: [{ name: `Pedido #${pedido.id}`, quantity: 1, unit_amount: valorCentavos }],
      webhook_url: webhookUrl,
      splits,
    });

    const qrCode = resposta?.qr_codes?.[0];
    const pixCode = qrCode?.text ?? null;
    const pixQrUrl = qrCode?.links?.find((l: any) => l.media === 'image/png')?.href ?? null;

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
  }) {
    const pedido = await this.buscarPedido(body.order_id);

    if (pedido.status !== 'pending') {
      throw new BadRequestException('Pedido não está pendente de pagamento');
    }

    const valorCentavos = Math.round(pedido.total * 100);
    const refId = `DELIVERY_${pedido.id}_${Date.now()}`;
    const tipo = body.tipo ?? 'CREDIT_CARD';
    const { client: pagbank, webhookUrl, splitConfig } = await this.getPagBankClient(pedido.restaurant_id);

    const splits = splitConfig ? this.buildSplits(valorCentavos, splitConfig) : undefined;

    const resposta = await pagbank.criarOrdemCartao({
      reference_id: refId,
      valor_centavos: valorCentavos,
      customer: {
        name: body.customer.name,
        email: body.customer.email,
        tax_id: this.limparCpf(body.customer.tax_id),
      },
      itens: [{ name: `Pedido #${pedido.id}`, quantity: 1, unit_amount: valorCentavos }],
      card_encrypted: body.card_encrypted,
      parcelas: body.parcelas ?? 1,
      tipo,
      webhook_url: webhookUrl,
      splits,
    });

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
      })
      .select()
      .single();

    if (error) throw error;

    if (statusPagamento === 'paid') {
      await this.supabase.client
        .from('orders')
        .update({ status: 'preparing', updated_at: new Date().toISOString() })
        .eq('id', pedido.id);
    }

    return {
      pagamento_id: pagamento.id,
      status: statusPagamento,
      pagbank_order_id: resposta.id,
      charge_id: charge?.id,
      split_ativo: !!splitConfig,
    };
  }

  async buscarPorPedido(orderId: number) {
    const { data, error } = await this.supabase.client
      .from('pagamentos')
      .select('id, tipo, status, valor, pix_code, pix_qr_url, pagbank_order_id, pago_em, criado_em')
      .eq('order_id', orderId)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    return { pagamentos: data ?? [] };
  }

  async processarWebhook(evento: any) {
    const payload = evento?.data ?? evento;
    const pagbankOrderId: string = payload?.id ?? payload?.reference_id;
    const charges: any[] = payload?.charges ?? [];
    const payments: any[] = payload?.payments ?? [];

    const detalhe = charges[0] ?? payments[0];
    if (!detalhe) return { ignorado: true };

    const statusPagbank: string = detalhe?.status ?? payload?.status ?? '';
    const pago = STATUS_PAGOS.includes(statusPagbank);

    const { data: pagamento } = await this.supabase.client
      .from('pagamentos')
      .select('id, order_id, status')
      .eq('pagbank_order_id', pagbankOrderId)
      .maybeSingle();

    if (!pagamento) return { ignorado: true, motivo: 'pagamento não encontrado' };
    if (pagamento.status === 'paid') return { ignorado: true, motivo: 'já processado' };

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
      await this.supabase.client
        .from('orders')
        .update({ status: 'preparing', updated_at: new Date().toISOString() })
        .eq('id', pagamento.order_id);
    }

    return { processado: true, status: novoStatus, order_id: pagamento.order_id };
  }
}

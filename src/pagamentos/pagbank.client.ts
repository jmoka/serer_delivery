// Cliente HTTP para PagBank API v4 — sandbox e produção
export class PagBankClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, sandbox: boolean) {
    this.token = token.trim();
    this.baseUrl = sandbox
      ? 'https://sandbox.api.pagseguro.com'
      : 'https://api.pagseguro.com';
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
      'x-api-version': '4.0',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json() as any;

    if (!res.ok) {
      const msg = json?.error_messages?.[0]?.description ?? json?.message ?? `HTTP ${res.status}`;
      throw new Error(`PagBank: ${msg}`);
    }

    return json as T;
  }

  // Cria ordem PIX — retorna qr_code e link
  // splits (opcional): distribui o valor entre vendedor e plataforma automaticamente
  async criarOrdemPix(params: {
    reference_id: string;
    valor_centavos: number;
    customer: { name: string; email: string; tax_id: string };
    itens: { name: string; quantity: number; unit_amount: number }[];
    webhook_url: string;
    splits?: Array<{
      method: 'FIXED' | 'PERCENTAGE';
      receivers: Array<{ account: { id: string }; amount: { value: number } }>;
    }>;
  }) {
    const expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const payload: Record<string, any> = {
      reference_id: params.reference_id,
      customer: params.customer,
      items: params.itens,
      qr_codes: [{ amount: { value: params.valor_centavos }, expiration_date: expiracao }],
      notification_urls: [params.webhook_url],
    };

    if (params.splits?.length) {
      payload.splits = params.splits;
    }

    return this.request<any>('POST', '/orders', payload);
  }

  // Cria ordem cartão — card.encrypted vem do PagBank.js no frontend
  // splits (opcional): distribui o valor entre vendedor e plataforma automaticamente
  async criarOrdemCartao(params: {
    reference_id: string;
    valor_centavos: number;
    customer: { name: string; email: string; tax_id: string };
    itens: { name: string; quantity: number; unit_amount: number }[];
    card_encrypted: string;
    parcelas: number;
    tipo: 'CREDIT_CARD' | 'DEBIT_CARD';
    webhook_url: string;
    splits?: Array<{
      method: 'FIXED' | 'PERCENTAGE';
      receivers: Array<{ account: { id: string }; amount: { value: number } }>;
    }>;
  }) {
    const payload: Record<string, any> = {
      reference_id: params.reference_id,
      customer: params.customer,
      items: params.itens,
      notification_urls: [params.webhook_url],
      charges: [{
        reference_id: `CHG_${params.reference_id}`,
        description: 'Pedido delivery',
        amount: { value: params.valor_centavos, currency: 'BRL' },
        payment_method: {
          type: params.tipo,
          installments: params.parcelas,
          capture: true,
          card: { encrypted: params.card_encrypted },
        },
      }],
    };

    if (params.splits?.length) {
      payload.splits = params.splits;
    }

    return this.request<any>('POST', '/orders', payload);
  }

  async buscarOrdem(pagbankOrderId: string) {
    return this.request<any>('GET', `/orders/${pagbankOrderId}`);
  }
}

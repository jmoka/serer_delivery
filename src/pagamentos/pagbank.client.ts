type PagBankCustomer = {
  name: string;
  email: string;
  tax_id: string;
  phones?: Array<{ country: string; area: string; number: string; type: 'MOBILE' | 'HOME' }>;
};

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

  // Cria ordem PIX via charges[].payment_method.pix — estrutura atual da API
  // (a antiga usava "qr_codes" solto na ordem; PagBank pediu migração em
  // 2026-09-18, ver reference/criar-pedido-com-qr-code-pix-v2). QR code e
  // link ficam em resposta.charges[0].qr_code / .links.
  // splits (opcional): distribui o valor entre vendedor e plataforma automaticamente
  async criarOrdemPix(params: {
    reference_id: string;
    valor_centavos: number;
    customer: PagBankCustomer;
    itens: { name: string; quantity: number; unit_amount: number }[];
    webhook_url: string;
    splits?: {
      method: 'FIXED' | 'PERCENTAGE';
      receivers: Array<{ account: { id: string }; amount: { value: number } }>;
    };
  }) {
    const expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const charge: Record<string, any> = {
      reference_id: `CHG_${params.reference_id}`,
      description: 'Pedido delivery',
      amount: { value: params.valor_centavos, currency: 'BRL' },
      payment_method: {
        type: 'PIX',
        pix: { expiration_date: expiracao },
      },
    };
    // Split fica dentro do charge, nunca na raiz do pedido — raiz aceita campo
    // desconhecido sem erro, então splits mal posicionado é ignorado em silêncio.
    if (params.splits) charge.splits = params.splits;

    const payload: Record<string, any> = {
      reference_id: params.reference_id,
      customer: params.customer,
      items: params.itens.map((item, i) => ({ reference_id: `ITEM_${i + 1}`, ...item })),
      notification_urls: [params.webhook_url],
      charges: [charge],
    };

    return this.request<any>('POST', '/orders', payload);
  }

  // Cria ordem cartão — card.encrypted vem do PagBank.js no frontend
  // splits (opcional): distribui o valor entre vendedor e plataforma automaticamente
  async criarOrdemCartao(params: {
    reference_id: string;
    valor_centavos: number;
    customer: PagBankCustomer;
    itens: { name: string; quantity: number; unit_amount: number }[];
    card_encrypted: string;
    parcelas: number;
    tipo: 'CREDIT_CARD' | 'DEBIT_CARD';
    webhook_url: string;
    splits?: {
      method: 'FIXED' | 'PERCENTAGE';
      receivers: Array<{ account: { id: string }; amount: { value: number } }>;
    };
  }) {
    const charge: Record<string, any> = {
      reference_id: `CHG_${params.reference_id}`,
      description: 'Pedido delivery',
      amount: { value: params.valor_centavos, currency: 'BRL' },
      payment_method: {
        type: params.tipo,
        installments: params.parcelas,
        capture: true,
        card: { encrypted: params.card_encrypted },
        holder: { name: params.customer.name, tax_id: params.customer.tax_id },
      },
    };
    // Split fica dentro do charge, nunca na raiz do pedido — raiz aceita campo
    // desconhecido sem erro, então splits mal posicionado é ignorado em silêncio.
    if (params.splits) charge.splits = params.splits;

    const payload: Record<string, any> = {
      reference_id: params.reference_id,
      customer: params.customer,
      items: params.itens.map((item, i) => ({ reference_id: `ITEM_${i + 1}`, ...item })),
      notification_urls: [params.webhook_url],
      charges: [charge],
    };

    return this.request<any>('POST', '/orders', payload);
  }

  async buscarOrdem(pagbankOrderId: string) {
    return this.request<any>('GET', `/orders/${pagbankOrderId}`);
  }

  // Chave pública usada pelo PagBank.js no navegador pra criptografar o cartão
  // antes de sair do cliente — o número do cartão nunca trafega em texto puro.
  async buscarChavePublica() {
    return this.request<{ public_key: string }>('GET', '/public-keys/card');
  }
}

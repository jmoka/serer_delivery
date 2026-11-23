// Cliente HTTP pra Evolution API (self-hosted, instância "Pediuvai") — mesmo padrão
// já usado pelo node "Enviar WhatsApp (Evolution)" do workflow n8n "PediuVai -
// WhatsApp": POST /message/sendText/:instance, header apikey, body { number, text }.
// `number` aceita tanto telefone puro (com DDI) quanto JID completo
// ("5591999999999@s.whatsapp.net") — usamos sempre o JID vindo do resgate do token,
// nunca telefone digitado, pra nunca ter erro de formatação.
export class WhatsappClient {
  private readonly baseUrl: string;

  constructor(
    evolutionUrl: string,
    private readonly apiKey: string,
    private readonly instance: string,
  ) {
    // EVOLUTION_URL aponta pro painel admin (.../manager) — a API fica na raiz do
    // mesmo host, sem esse sufixo.
    this.baseUrl = evolutionUrl.replace(/\/manager\/?$/, '').replace(/\/$/, '');
  }

  async sendText(number: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/message/sendText/${this.instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: JSON.stringify({ number, text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Evolution: HTTP ${res.status} ${body}`);
    }
  }
}

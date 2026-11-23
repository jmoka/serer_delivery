// Gerenciamento de instâncias Evolution API (criar/checar conexão/deletar/webhook) —
// diferente de WhatsappClient (src/whatsapp/whatsapp.client.ts), que só manda
// mensagem numa instância JÁ fixa (a "Pediuvai" compartilhada). Aqui a instância é
// um parâmetro por chamada, porque cada estabelecimento com o Assistente IA ativo
// tem a sua própria.
//
// Confirmado contra a instância real (v2.3.7, GET / sem path) nesta sessão: shapes
// baseados na doc pública da Evolution API v2 + teste real já feito pro endpoint de
// webhook (POST /webhook/set/:instance, mesmo formato usado aqui) — mas a criação de
// instância em si (create/connectionState/delete) NUNCA foi exercitada de verdade
// nesse projeto ainda. Testar contra uma loja piloto antes de confiar 100%.
export interface QrCodeResult {
  base64: string | null;
  connectedDireto: boolean; // alguns fluxos conectam sem precisar escanear (ex: já pareado)
}

export class EvolutionManagerClient {
  private readonly baseUrl: string;

  constructor(
    evolutionUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = evolutionUrl.replace(/\/manager\/?$/, '').replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`Evolution: HTTP ${res.status} ${text}`);
    }
    return json as T;
  }

  async criarInstancia(instanceName: string): Promise<QrCodeResult> {
    const json = await this.request<any>('POST', '/instance/create', {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
    return {
      base64: json?.qrcode?.base64 ?? null,
      connectedDireto: json?.instance?.status === 'open',
    };
  }

  // Gera um QR novo pra uma instância já criada mas desconectada/expirada (sem
  // precisar deletar e recriar do zero).
  async reconectar(instanceName: string): Promise<QrCodeResult> {
    const json = await this.request<any>('GET', `/instance/connect/${instanceName}`);
    return {
      base64: json?.base64 ?? json?.qrcode?.base64 ?? null,
      connectedDireto: false,
    };
  }

  async estadoConexao(instanceName: string): Promise<'open' | 'close' | 'connecting'> {
    const json = await this.request<any>('GET', `/instance/connectionState/${instanceName}`);
    return json?.instance?.state ?? 'close';
  }

  async deletarInstancia(instanceName: string): Promise<void> {
    await this.request('DELETE', `/instance/delete/${instanceName}`);
  }

  // Mesmo formato já confirmado funcionando nesta sessão pra instância "Pediuvai"
  // (ver feedback_evolution_webhookbyevents_forcado na memória do projeto): a
  // Evolution sempre AGREGA o sufixo do evento na URL configurada — nunca incluir
  // o sufixo aqui, senão a chamada real vira .../messages-upsert/messages-upsert.
  async configurarWebhook(instanceName: string, url: string): Promise<void> {
    await this.request('POST', `/webhook/set/${instanceName}`, {
      webhook: { url, enabled: true, webhookByEvents: true, webhookBase64: true, events: ['MESSAGES_UPSERT'] },
    });
  }
}

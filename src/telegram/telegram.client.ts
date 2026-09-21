// Cliente HTTP para a Bot API do Telegram
export class TelegramClient {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async request<T>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as any;

    if (!res.ok || json?.ok === false) {
      throw new Error(`Telegram: ${json?.description ?? `HTTP ${res.status}`}`);
    }

    return json.result as T;
  }

  sendMessage(chatId: number, text: string) {
    return this.request('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
  }

  setWebhook(url: string, secretToken: string) {
    return this.request('setWebhook', { url, secret_token: secretToken });
  }
}

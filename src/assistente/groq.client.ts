// Cliente HTTP mínimo pra Groq (API compatível com o formato de chat completions
// da OpenAI, incluindo tool/function calling) — mesmo estilo minimalista de
// TelegramClient/WhatsappClient, sem SDK.
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class GroqClient {
  private readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chatCompletion(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatMessage> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    });

    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`Groq: ${json?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return json.choices[0].message as ChatMessage;
  }
}

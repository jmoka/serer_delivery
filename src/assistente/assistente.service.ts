import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { EncryptionService } from '../common/encryption.service';
import { TelegramClient } from '../telegram/telegram.client';
import { WhatsappClient } from '../whatsapp/whatsapp.client';
import { EvolutionManagerClient, EvolutionHttpError } from './evolution-manager.client';
import { GroqClient, ChatMessage, ToolSpec } from './groq.client';

const HISTORICO_MAX_MENSAGENS = 10;
// QR do WhatsApp expira depois disso — precisa bater com QR_TTL_MS em
// restaurante-assistente-ia/index.jsx (frontend só espelha pra contagem,
// backend é a fonte da verdade).
const QR_TTL_MS = 120_000;

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_produto_da_loja',
      description: 'Busca produtos do cardápio desta loja por nome (ex: "pizza", "refrigerante"). Use quando o cliente perguntar sobre um prato/produto específico.',
      parameters: {
        type: 'object',
        properties: { termo: { type: 'string', description: 'Nome ou parte do nome do produto buscado' } },
        required: ['termo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'informacoes_estabelecimento',
      description: 'Retorna nome, endereço, horário de funcionamento e taxa de entrega desta loja. Use quando o cliente perguntar sobre endereço, horário ou frete.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

@Injectable()
export class AssistenteService {
  private readonly logger = new Logger(AssistenteService.name);
  private readonly groq: GroqClient | null;
  private readonly evolutionManager: EvolutionManagerClient | null;
  private readonly backendPublicUrl: string;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private encryption: EncryptionService,
  ) {
    const groqKey = config.get<string>('GROQ_API_KEY');
    const groqModel = config.get<string>('GROQ_MODEL') || 'openai/gpt-oss-120b';
    this.groq = groqKey ? new GroqClient(groqKey, groqModel) : null;
    if (!groqKey) this.logger.warn('GROQ_API_KEY não configurada — Assistente IA fica desligado.');

    const evolutionUrl = config.get<string>('EVOLUTION_URL');
    const evolutionKey = config.get<string>('EVOLUTION_KEY');
    this.evolutionManager = evolutionUrl && evolutionKey ? new EvolutionManagerClient(evolutionUrl, evolutionKey) : null;

    this.backendPublicUrl = (config.get<string>('BACKEND_PUBLIC_URL') || '').replace(/\/$/, '');
  }

  // Reusa o nome já salvo quando a instância já existe (não pode recalcular do
  // slug atual — se o slug mudar depois, perderia a referência da instância
  // já criada no Evolution). Só na primeira criação busca o slug da loja.
  private async obterNomeInstancia(restaurantId: number, cfg: { whatsapp_evolution_instance?: string | null }): Promise<string> {
    if (cfg.whatsapp_evolution_instance) return cfg.whatsapp_evolution_instance;
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('slug')
      .eq('id', restaurantId)
      .maybeSingle();
    const base = data?.slug || `loja-${restaurantId}`;
    return `assistente-${base}`;
  }

  private instanciaExpirada(cfg: { whatsapp_connection_status?: string | null; whatsapp_qr_gerado_em?: string | null }): boolean {
    return (
      cfg.whatsapp_connection_status === 'aguardando_qr' &&
      !!cfg.whatsapp_qr_gerado_em &&
      Date.now() - new Date(cfg.whatsapp_qr_gerado_em).getTime() > QR_TTL_MS
    );
  }

  private async buscarOuCriarConfig(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (data) return data;

    const { data: criado, error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .insert({ restaurant_id: restaurantId })
      .select('*')
      .single();
    if (error) throw error;
    return criado;
  }

  async obterConfig(restaurantId: number) {
    const cfg = await this.buscarOuCriarConfig(restaurantId);
    return {
      prompt_sistema: cfg.prompt_sistema,
      ativo_whatsapp: cfg.ativo_whatsapp,
      ativo_telegram: cfg.ativo_telegram,
      whatsapp_connection_status: cfg.whatsapp_connection_status,
      telegram_bot_username: cfg.telegram_bot_username,
    };
  }

  async salvarPrompt(restaurantId: number, prompt: string) {
    await this.buscarOuCriarConfig(restaurantId);
    const { error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({ prompt_sistema: prompt, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // --- Telegram ---------------------------------------------------------

  async conectarTelegram(restaurantId: number, token: string) {
    if (!token?.trim()) throw new BadRequestException('Informe o token do bot.');
    if (!this.backendPublicUrl) throw new BadRequestException('BACKEND_PUBLIC_URL não configurada no servidor.');

    const client = new TelegramClient(token.trim());
    let me: { id: number; username: string };
    try {
      me = await client.getMe();
    } catch (e: any) {
      throw new BadRequestException(`Token inválido: ${e.message}`);
    }

    const secret = crypto.randomBytes(24).toString('hex');
    await client.setWebhook(`${this.backendPublicUrl}/assistente/webhook/telegram/${restaurantId}`, secret);

    await this.buscarOuCriarConfig(restaurantId);
    const { error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({
        telegram_bot_token_enc: this.encryption.encryptNullable(token.trim()),
        telegram_bot_username: me.username,
        telegram_webhook_secret: secret,
        ativo_telegram: true,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;

    return { ok: true, username: me.username };
  }

  async desconectarTelegram(restaurantId: number) {
    const cfg = await this.buscarOuCriarConfig(restaurantId);
    const token = this.encryption.decryptNullable(cfg.telegram_bot_token_enc);
    if (token) {
      await new TelegramClient(token).deleteWebhook().catch((e) => this.logger.warn(`Falha ao remover webhook Telegram: ${e.message}`));
    }
    const { error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({
        telegram_bot_token_enc: null,
        telegram_bot_username: null,
        telegram_webhook_secret: null,
        ativo_telegram: false,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // --- WhatsApp (Evolution) ----------------------------------------------

  async conectarWhatsapp(restaurantId: number) {
    if (!this.evolutionManager) throw new BadRequestException('Evolution API não configurada no servidor.');
    if (!this.backendPublicUrl) throw new BadRequestException('BACKEND_PUBLIC_URL não configurada no servidor.');

    const cfg = await this.buscarOuCriarConfig(restaurantId);

    if (cfg.whatsapp_connection_status === 'conectado' && cfg.ativo_whatsapp) {
      throw new BadRequestException('WhatsApp já está conectado. Desconecte antes de gerar um novo QR.');
    }

    const expirada = this.instanciaExpirada(cfg);
    const instance = await this.obterNomeInstancia(restaurantId, cfg);

    if (expirada && cfg.whatsapp_evolution_instance) {
      // QR anterior passou do TTL — limpa a instância velha antes de recriar
      // do zero (pedido do usuário: expirar não pode deixar lixo no Evolution).
      await this.evolutionManager
        .deletarInstancia(cfg.whatsapp_evolution_instance)
        .catch((e: any) => this.logger.warn(`Falha ao deletar instância expirada '${cfg.whatsapp_evolution_instance}': ${e.message}`));
    }

    let qr;
    try {
      qr = cfg.whatsapp_evolution_instance && !expirada
        ? await this.evolutionManager.reconectar(instance)
        : await this.evolutionManager.criarInstancia(instance);
    } catch (e: any) {
      if (e instanceof EvolutionHttpError && e.status === 404 && cfg.whatsapp_evolution_instance) {
        // Instância salva no banco não existe mais no Evolution (apagada manual
        // por fora, por exemplo) — recria do zero em vez de propagar o 404.
        try {
          qr = await this.evolutionManager.criarInstancia(instance);
        } catch (e2: any) {
          this.logger.error(`Falha ao criar instância Evolution '${instance}' (loja ${restaurantId}): ${e2.message}`);
          throw new BadRequestException('Não foi possível gerar o QR code agora. Tente novamente em alguns instantes.');
        }
      } else {
        this.logger.error(`Falha ao conectar WhatsApp (loja ${restaurantId}, instância '${instance}'): ${e.message}`);
        throw new BadRequestException('Não foi possível gerar o QR code agora. Tente novamente em alguns instantes.');
      }
    }

    await this.evolutionManager
      .configurarWebhook(instance, `${this.backendPublicUrl}/assistente/webhook/whatsapp/${instance}`)
      .catch((e: any) => this.logger.warn(`Falha ao configurar webhook da instância '${instance}': ${e.message}`));

    const { error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({
        whatsapp_evolution_instance: instance,
        whatsapp_connection_status: qr.connectedDireto ? 'conectado' : 'aguardando_qr',
        ativo_whatsapp: qr.connectedDireto,
        whatsapp_qr_gerado_em: qr.connectedDireto ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;

    return { ok: true, qrcode_base64: qr.base64, status: qr.connectedDireto ? 'conectado' : 'aguardando_qr' };
  }

  async statusWhatsapp(restaurantId: number) {
    const cfg = await this.buscarOuCriarConfig(restaurantId);
    if (!this.evolutionManager || !cfg.whatsapp_evolution_instance) {
      return { status: cfg.whatsapp_connection_status ?? 'desconectado' };
    }

    if (this.instanciaExpirada(cfg)) {
      await this.evolutionManager
        .deletarInstancia(cfg.whatsapp_evolution_instance)
        .catch((e: any) => this.logger.warn(`Falha ao deletar instância expirada '${cfg.whatsapp_evolution_instance}': ${e.message}`));
      await this.supabase.client
        .from('assistentes_estabelecimento')
        .update({
          whatsapp_evolution_instance: null,
          whatsapp_connection_status: 'expirado',
          ativo_whatsapp: false,
          whatsapp_qr_gerado_em: null,
          updated_at: new Date().toISOString(),
        })
        .eq('restaurant_id', restaurantId);
      return { status: 'expirado' };
    }

    let estado: 'open' | 'close' | 'connecting';
    try {
      estado = await this.evolutionManager.estadoConexao(cfg.whatsapp_evolution_instance);
    } catch (e: any) {
      this.logger.warn(`Falha ao consultar estado da instância '${cfg.whatsapp_evolution_instance}': ${e.message}`);
      return { status: cfg.whatsapp_connection_status ?? 'desconectado' };
    }
    const status = estado === 'open' ? 'conectado' : estado === 'connecting' ? 'aguardando_qr' : 'desconectado';

    await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({ whatsapp_connection_status: status, ativo_whatsapp: status === 'conectado' })
      .eq('restaurant_id', restaurantId);

    return { status };
  }

  async desconectarWhatsapp(restaurantId: number) {
    const cfg = await this.buscarOuCriarConfig(restaurantId);
    if (this.evolutionManager && cfg.whatsapp_evolution_instance) {
      await this.evolutionManager
        .deletarInstancia(cfg.whatsapp_evolution_instance)
        .catch((e) => this.logger.warn(`Falha ao deletar instância Evolution: ${e.message}`));
    }
    const { error } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .update({
        whatsapp_evolution_instance: null,
        whatsapp_connection_status: 'desconectado',
        ativo_whatsapp: false,
        whatsapp_qr_gerado_em: null,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // --- Núcleo do agente ---------------------------------------------------

  async restaurantIdPorInstanciaWhatsapp(instance: string): Promise<number | null> {
    const { data } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .select('restaurant_id')
      .eq('whatsapp_evolution_instance', instance)
      .eq('ativo_whatsapp', true)
      .maybeSingle();
    return data?.restaurant_id ?? null;
  }

  async validarSecretTelegram(restaurantId: number, secret: string): Promise<boolean> {
    const { data } = await this.supabase.client
      .from('assistentes_estabelecimento')
      .select('telegram_webhook_secret, ativo_telegram')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    return !!data?.ativo_telegram && !!secret && data.telegram_webhook_secret === secret;
  }

  private async executarTool(restaurantId: number, nome: string, args: Record<string, any>): Promise<string> {
    if (nome === 'buscar_produto_da_loja') {
      const { data } = await this.supabase.client
        .from('products')
        .select('name, price, preco_promo, quantidade_estoque')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true)
        .ilike('name', `%${args.termo ?? ''}%`)
        .limit(10);
      if (!data?.length) return 'Nenhum produto encontrado com esse termo.';
      return JSON.stringify(
        data.map((p) => ({ nome: p.name, preco: p.preco_promo > 0 ? p.preco_promo : p.price, em_estoque: p.quantidade_estoque > 0 })),
      );
    }

    if (nome === 'informacoes_estabelecimento') {
      const { data } = await this.supabase.client
        .from('restaurants')
        .select('name, address, neighborhood, city, state, business_hours, frete_motoboy')
        .eq('id', restaurantId)
        .maybeSingle();
      if (!data) return 'Informações não encontradas.';
      return JSON.stringify({
        nome: data.name,
        endereco: [data.address, data.neighborhood, data.city, data.state].filter(Boolean).join(', '),
        horario_funcionamento: data.business_hours,
        taxa_entrega: data.frete_motoboy,
      });
    }

    return 'Tool desconhecida.';
  }

  // Chamado pelos dois webhook handlers (Telegram e WhatsApp) — não sabe de onde
  // veio a mensagem além de (restaurantId, canal, chatId), resto é simétrico.
  async responderMensagem(restaurantId: number, canal: 'whatsapp' | 'telegram', chatId: string, texto: string) {
    if (!this.groq) {
      this.logger.warn('Mensagem recebida pro Assistente IA mas GROQ_API_KEY não está configurada — ignorada.');
      return;
    }
    if (!texto?.trim()) return;

    const cfg = await this.buscarOuCriarConfig(restaurantId);

    const { data: historico } = await this.supabase.client
      .from('assistente_conversas')
      .select('role, content')
      .eq('restaurant_id', restaurantId)
      .eq('canal', canal)
      .eq('chat_id', chatId)
      .order('criado_em', { ascending: false })
      .limit(HISTORICO_MAX_MENSAGENS);

    const mensagens: ChatMessage[] = [
      { role: 'system', content: cfg.prompt_sistema || 'Você é um assistente de atendimento simpático e objetivo.' },
      ...((historico ?? []).reverse() as { role: 'user' | 'assistant'; content: string }[]),
      { role: 'user', content: texto },
    ];

    let resposta = await this.groq.chatCompletion(mensagens, TOOLS);

    // Loop de tool-calling simples (no máximo 1 rodada) — v1 não precisa de
    // encadeamento arbitrário de tools, só resolver a pergunta mais comum.
    if (resposta.tool_calls?.length) {
      mensagens.push(resposta);
      for (const call of resposta.tool_calls) {
        const args = JSON.parse(call.function.arguments || '{}');
        const resultado = await this.executarTool(restaurantId, call.function.name, args);
        mensagens.push({ role: 'tool', tool_call_id: call.id, content: resultado });
      }
      resposta = await this.groq.chatCompletion(mensagens, TOOLS);
    }

    const textoResposta = resposta.content?.trim();
    if (!textoResposta) return;

    await this.supabase.client.from('assistente_conversas').insert([
      { restaurant_id: restaurantId, canal, chat_id: chatId, role: 'user', content: texto },
      { restaurant_id: restaurantId, canal, chat_id: chatId, role: 'assistant', content: textoResposta },
    ]);

    if (canal === 'telegram') {
      const token = this.encryption.decryptNullable(cfg.telegram_bot_token_enc);
      if (token) await new TelegramClient(token).sendMessage(chatId, textoResposta).catch((e) => this.logger.warn(`Falha ao responder Telegram: ${e.message}`));
    } else {
      const evolutionUrl = this.config.get<string>('EVOLUTION_URL');
      const evolutionKey = this.config.get<string>('EVOLUTION_KEY');
      if (evolutionUrl && evolutionKey && cfg.whatsapp_evolution_instance) {
        await new WhatsappClient(evolutionUrl, evolutionKey, cfg.whatsapp_evolution_instance)
          .sendText(chatId, textoResposta)
          .catch((e) => this.logger.warn(`Falha ao responder WhatsApp: ${e.message}`));
      }
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export type MotoboyAcao = 'concorrer' | 'pegar';

export interface ResgateAcao {
  expirado: boolean;
  orderId: number;
  motoboyId: number;
  acao: MotoboyAcao;
}

// Gera/resgata o link de ação de um clique mandado por Telegram/WhatsApp (ver
// TelegramService/WhatsappService). BACKEND_PUBLIC_URL ausente = sem link nas
// mensagens, só o texto — nunca quebra o envio da notificação em si.
@Injectable()
export class MotoboyAcaoLinkService {
  private readonly logger = new Logger(MotoboyAcaoLinkService.name);

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  async gerarLink(acao: MotoboyAcao, orderId: number, motoboyId: number): Promise<string | null> {
    const base = (this.config.get<string>('BACKEND_PUBLIC_URL') || '').replace(/\/$/, '');
    if (!base) return null;

    const token = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    const { error } = await this.supabase.client
      .from('motoboy_acao_tokens')
      .insert({ order_id: orderId, motoboy_id: motoboyId, acao, token, expira_em: expiraEm });
    if (error) {
      this.logger.warn(`Falha ao gerar token de ação (order ${orderId}, motoboy ${motoboyId}): ${error.message}`);
      return null;
    }
    return `${base}/motoboy/acao/${token}`;
  }

  // Apaga o token no resgate independente de ter expirado ou não — uso único sempre,
  // mesmo espírito do telegram_link_tokens.
  async resgatar(token: string): Promise<ResgateAcao | null> {
    const { data } = await this.supabase.client
      .from('motoboy_acao_tokens')
      .select('order_id, motoboy_id, acao, expira_em')
      .eq('token', token)
      .maybeSingle();
    if (!data) return null;

    await this.supabase.client.from('motoboy_acao_tokens').delete().eq('token', token);

    return {
      expirado: new Date(data.expira_em) < new Date(),
      orderId: data.order_id,
      motoboyId: data.motoboy_id,
      acao: data.acao,
    };
  }
}

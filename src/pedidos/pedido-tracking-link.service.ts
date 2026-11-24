import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias — cliente pode reabrir o link várias vezes

// Fallback só usado se MARKETPLACE_BASE_URL não estiver setada — mesmo padrão de
// catalogo.controller.ts / telegram.service.ts / whatsapp.service.ts.
const MARKETPLACE_BASE_URL = process.env.MARKETPLACE_BASE_URL ?? 'https://pediuvai.teucurso.top';

// Link "acompanhar pedido" sem login (ver migration pedido_tracking_tokens). Diferente
// do MotoboyAcaoLinkService: token não é apagado no resgate (reusável, só expira).
@Injectable()
export class PedidoTrackingLinkService {
  private readonly logger = new Logger(PedidoTrackingLinkService.name);

  constructor(private supabase: SupabaseService) {}

  // Reusa o token existente (mesmo link) se a mensagem de confirmação for reenviada —
  // evita invalidar um link que o cliente já pode ter salvo/aberto.
  async gerarLink(orderId: number): Promise<string | null> {
    const { data: existente } = await this.supabase.client
      .from('pedido_tracking_tokens')
      .select('token, expira_em')
      .eq('order_id', orderId)
      .maybeSingle();
    if (existente && new Date(existente.expira_em) > new Date()) {
      return `${MARKETPLACE_BASE_URL}/acompanhar/${existente.token}`;
    }

    const token = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    const { error } = await this.supabase.client
      .from('pedido_tracking_tokens')
      .upsert({ order_id: orderId, token, expira_em: expiraEm }, { onConflict: 'order_id' });
    if (error) {
      this.logger.warn(`Falha ao gerar token de acompanhamento (order ${orderId}): ${error.message}`);
      return null;
    }
    return `${MARKETPLACE_BASE_URL}/acompanhar/${token}`;
  }

  // null = token inválido. orderId presente + expirado = o controller decide a mensagem.
  async resolverOrderId(token: string): Promise<{ orderId: number; expirado: boolean } | null> {
    const { data } = await this.supabase.client
      .from('pedido_tracking_tokens')
      .select('order_id, expira_em')
      .eq('token', token)
      .maybeSingle();
    if (!data) return null;
    return { orderId: data.order_id, expirado: new Date(data.expira_em) < new Date() };
  }
}

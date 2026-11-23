import { Body, Controller, Headers, Param, Post, UnauthorizedException } from '@nestjs/common';
import { AssistenteService } from './assistente.service';

// Público — recebe mensagem direto da instância Evolution OU do bot Telegram
// PRÓPRIO de cada estabelecimento (nunca a instância/bot compartilhado do
// Pediuvai, que tem seus próprios webhooks em telegram.controller.ts e no
// workflow n8n "PediuVai - WhatsApp").
@Controller('assistente/webhook')
export class AssistenteWebhookController {
  constructor(private service: AssistenteService) {}

  // Payload igual ao que a Evolution manda pro workflow n8n (ver Edit Fields do
  // workflow "PediuVai - WhatsApp"): body.data.key.{remoteJid,fromMe,id},
  // body.data.message.conversation.
  @Post('whatsapp/:instance')
  async webhookWhatsapp(@Param('instance') instance: string, @Body() body: any) {
    const fromMe = body?.data?.key?.fromMe;
    const texto: string | undefined = body?.data?.message?.conversation;
    const jid: string | undefined = body?.data?.key?.remoteJid;
    if (fromMe || !texto?.trim() || !jid) return { ok: true };

    const restaurantId = await this.service.restaurantIdPorInstanciaWhatsapp(instance);
    if (!restaurantId) return { ok: true };

    await this.service.responderMensagem(restaurantId, 'whatsapp', jid, texto);
    return { ok: true };
  }

  // Telegram não assina o corpo, mas ecoa de volta o secret_token fixo configurado
  // via setWebhook — mesmo princípio de telegram.controller.ts, só que o secret é
  // por restaurante aqui (cada um tem o próprio bot).
  @Post('telegram/:restaurantId')
  async webhookTelegram(@Param('restaurantId') restaurantId: string, @Headers('x-telegram-bot-api-secret-token') secret: string, @Body() body: any) {
    const id = Number(restaurantId);
    const valido = await this.service.validarSecretTelegram(id, secret);
    if (!valido) throw new UnauthorizedException();

    const chatId = body?.message?.chat?.id;
    const texto: string | undefined = body?.message?.text;
    if (!chatId || !texto?.trim()) return { ok: true };

    await this.service.responderMensagem(id, 'telegram', String(chatId), texto);
    return { ok: true };
  }
}

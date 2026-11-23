import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';

// Diferente do Telegram (Evolution chama esse endpoint direto): a Evolution só tem UM
// webhook por instância, e esse já pertence ao workflow n8n "PediuVai - WhatsApp" (AI
// Agent de atendimento). Em vez de brigar pelo webhook (mesmo bug já resolvido uma vez
// pro Telegram com 2 bots — ver [[project_deliveryhub_whatsapp_banido]]), o próprio
// workflow n8n intercepta "/start <token>" antes do AI Agent e chama esse endpoint.
@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private service: WhatsappService,
    private config: ConfigService,
  ) {}

  @Post('n8n/redimir')
  async redimir(@Headers('x-whatsapp-n8n-secret') secret: string, @Body() body: { token: string; chatId: string }) {
    if (!secret || secret !== this.config.get<string>('WHATSAPP_N8N_SECRET')) {
      throw new UnauthorizedException();
    }
    if (!body?.token || !body?.chatId) return { ok: false };

    await this.service.redimirToken(body.token, body.chatId);
    return { ok: true };
  }
}

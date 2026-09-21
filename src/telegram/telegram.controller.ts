import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(
    private service: TelegramService,
    private config: ConfigService,
  ) {}

  // Webhook do bot — Telegram não assina o corpo, mas ecoa de volta um secret_token
  // fixo (configurado via setWebhook) em todo update, o que dá uma verificação de
  // origem real, mais forte que o webhook do PagBank (que não tem assinatura nenhuma).
  @Post('webhook')
  async webhook(@Req() req: any, @Body() body: any) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')) {
      throw new UnauthorizedException();
    }

    const msg = body?.message;
    const chatId = msg?.chat?.id;
    const text: string | undefined = msg?.text;

    if (chatId && text?.startsWith('/start ')) {
      await this.service.redimirToken(text.slice(7).trim(), chatId);
    }

    return { ok: true };
  }
}

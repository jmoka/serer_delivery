import { Body, Controller, Post } from '@nestjs/common';
import { PlanosService } from './planos.service';

// Sem guard — PagBank não envia token de autenticação nos webhooks (mesmo padrão de /pagamentos/webhook)
@Controller('planos')
export class PlanosWebhookController {
  constructor(private service: PlanosService) {}

  @Post('webhook')
  webhook(@Body() body: any) {
    return this.service.processarWebhook(body);
  }
}

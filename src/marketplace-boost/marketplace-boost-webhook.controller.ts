import { Body, Controller, Post } from '@nestjs/common';
import { MarketplaceBoostService } from './marketplace-boost.service';

// Sem guard — PagBank não envia token de autenticação nos webhooks (mesmo padrão de /planos/webhook)
@Controller('marketplace-boost')
export class MarketplaceBoostWebhookController {
  constructor(private service: MarketplaceBoostService) {}

  @Post('webhook')
  webhook(@Body() body: any) {
    return this.service.processarWebhook(body);
  }
}

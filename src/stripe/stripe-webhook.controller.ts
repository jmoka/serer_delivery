import { BadRequestException, Controller, Headers, Post, Req } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeWebhookController {
  constructor(private service: StripeService) {}

  @Post('webhook')
  async webhook(@Req() req: any, @Headers('stripe-signature') assinatura: string) {
    // req.body chega como Buffer cru (configurado em main.ts só para esta
    // rota) — assinatura é verificada de verdade aqui, diferente do webhook
    // do PagBank (que não assina nada e por isso reconsulta a API).
    if (!assinatura) throw new BadRequestException('Assinatura ausente');

    let evento: Stripe.Event;
    try {
      evento = await this.service.construirEvento(req.body, assinatura);
    } catch {
      throw new BadRequestException('Assinatura inválida');
    }

    if (evento.type === 'account.updated') {
      const conta = evento.data.object as Stripe.Account;
      await this.service.sincronizarConta(conta);
    }

    return { recebido: true };
  }
}

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

    if (evento.type === 'payment_intent.succeeded' || evento.type === 'payment_intent.payment_failed' || evento.type === 'payment_intent.canceled') {
      const intent = evento.data.object as Stripe.PaymentIntent;
      await this.service.processarPaymentIntent(intent);
    }

    return { recebido: true };
  }

  // Endpoint SEPARADO — precisa ser cadastrado no dashboard Stripe com escopo "Contas
  // conectadas" (Connect), não "Sua conta". payout.paid é disparado pela conta conectada
  // (da loja) quando a Stripe efetivamente manda o dinheiro pro banco dela; o ID da conta
  // vem em `evento.account`, não no corpo do evento.
  @Post('webhook-connect')
  async webhookConnect(@Req() req: any, @Headers('stripe-signature') assinatura: string) {
    if (!assinatura) throw new BadRequestException('Assinatura ausente');

    let evento: Stripe.Event;
    try {
      evento = await this.service.construirEventoConnect(req.body, assinatura);
    } catch {
      throw new BadRequestException('Assinatura inválida');
    }

    if (evento.type === 'payout.paid') {
      const payout = evento.data.object as Stripe.Payout;
      await this.service.processarPayout(payout, (evento as any).account);
    }

    return { recebido: true };
  }
}

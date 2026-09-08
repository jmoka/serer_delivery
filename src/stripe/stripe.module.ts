import { Module } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { AuthModule } from '../auth/auth.module';
import { PedidosModule } from '../pedidos/pedidos.module';

@Module({
  imports: [AuthModule, PedidosModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}

import { Module } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService],
})
export class StripeModule {}

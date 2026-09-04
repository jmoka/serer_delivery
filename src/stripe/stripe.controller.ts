import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { StripeService } from './stripe.service';

@Controller('restaurante/stripe')
@UseGuards(RestaurantOwnerGuard)
export class StripeController {
  constructor(private service: StripeService) {}

  @Post('onboarding-link')
  onboardingLink(@Req() req: any) {
    // Origin não tem path (só scheme+host); Referer (fallback) tem, então
    // reduz para a origem antes de montar as URLs de retorno do Stripe.
    const bruto = req.headers['origin'] || req.headers['referer'] || '';
    const origem = new URL(bruto).origin;
    return this.service.gerarLinkOnboarding(req.restaurantId, origem);
  }

  @Get('status')
  status(@Req() req: any) {
    return this.service.status(req.restaurantId);
  }
}

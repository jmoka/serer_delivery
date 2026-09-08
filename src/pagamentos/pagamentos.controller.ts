import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PagamentosService } from './pagamentos.service';
import { JwtGuard } from '../auth/jwt.guard';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('pagamentos')
export class PagamentosController {
  constructor(private service: PagamentosService) {}

  // Cliente cria PIX para seu pedido
  @Post('pix')
  @UseGuards(JwtGuard)
  criarPix(
    @Body() body: {
      order_id: number;
      customer: { name: string; email: string; tax_id: string };
    },
    @Req() req: any,
  ) {
    return this.service.criarPix(body, req.userId);
  }

  // Cliente paga com cartão (token encrypted via PagBank.js no frontend)
  @Post('cartao')
  @UseGuards(JwtGuard)
  criarCartao(
    @Body() body: {
      order_id: number;
      customer: { name: string; email: string; tax_id: string };
      card_encrypted: string;
      parcelas?: number;
      tipo?: 'CREDIT_CARD' | 'DEBIT_CARD';
    },
    @Req() req: any,
  ) {
    return this.service.criarCartao(body, req.userId);
  }

  // Cliente paga com cartão via Stripe Connect (Payment Element no frontend)
  @Post('stripe')
  @UseGuards(JwtGuard)
  criarStripe(@Body() body: { order_id: number }, @Req() req: any) {
    return this.service.criarStripe(body, req.userId);
  }

  // Consulta pagamentos de um pedido
  @Get('pedido/:id')
  @UseGuards(JwtGuard)
  buscarPorPedido(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.buscarPorPedido(id, req.userId, req.userRole);
  }

  // Webhook PagBank — sem auth (PagBank não envia token)
  @Post('webhook')
  webhook(@Body() body: any) {
    return this.service.processarWebhook(body);
  }

  // Tela do estabelecimento: vendas via Stripe com tarifa/comissão/líquido e status de repasse
  @Get('restaurante/stripe')
  @UseGuards(RestaurantOwnerGuard)
  listarStripeRestaurante(@Req() req: any, @Query() q: { page?: string; limit?: string }) {
    return this.service.listarStripeRestaurante(req.restaurantId, { page: Number(q.page) || 1, limit: Number(q.limit) || 50 });
  }

  // Mesma tela pro admin, olhando qualquer loja (ou todas)
  @Get('admin/stripe')
  @UseGuards(AdminGuard)
  listarStripeAdmin(@Query() q: { restaurante_id?: string; page?: string; limit?: string }) {
    return this.service.listarStripeAdmin({
      restaurantId: q.restaurante_id ? Number(q.restaurante_id) : undefined,
      page: Number(q.page) || 1,
      limit: Number(q.limit) || 50,
    });
  }
}

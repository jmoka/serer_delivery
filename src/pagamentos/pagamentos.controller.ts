import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { PagamentosService } from './pagamentos.service';
import { JwtGuard } from '../auth/jwt.guard';

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
  ) {
    return this.service.criarPix(body);
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
  ) {
    return this.service.criarCartao(body);
  }

  // Consulta pagamentos de um pedido
  @Get('pedido/:id')
  @UseGuards(JwtGuard)
  buscarPorPedido(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscarPorPedido(id);
  }

  // Webhook PagBank — sem auth (PagBank não envia token)
  @Post('webhook')
  webhook(@Body() body: any) {
    return this.service.processarWebhook(body);
  }
}

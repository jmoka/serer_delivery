import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { AgenteImpressaoService } from './agente-impressao.service';

@Controller('restaurante/agente-impressao')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteAgenteImpressaoController {
  constructor(private service: AgenteImpressaoService) {}

  @Post('gerar-token')
  gerarToken(@Req() req: any) {
    return this.service.gerarToken(req.restaurantId);
  }

  @Get('status')
  status(@Req() req: any) {
    return this.service.statusAgente(req.restaurantId);
  }
}

import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { GdoorService } from './gdoor.service';

@Controller('restaurante/gdoor')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteGdoorController {
  constructor(private service: GdoorService) {}

  @Post('gerar-token')
  gerarToken(@Req() req: any) {
    return this.service.gerarToken(req.restaurantId);
  }

  @Get('status')
  status(@Req() req: any) {
    return this.service.statusAgente(req.restaurantId);
  }

  @Patch('cnpj-esperado')
  salvarCnpjEsperado(@Body() body: { cnpj: string }, @Req() req: any) {
    return this.service.salvarCnpjEsperado(req.restaurantId, body.cnpj);
  }
}

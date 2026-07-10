import { Body, Controller, Param, ParseIntPipe, Patch, Post, Get, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { MotoboyService } from './motoboy.service';

@Controller('restaurante/motoboys')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteMotoboysController {
  constructor(private service: MotoboyService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.restaurantId);
  }

  @Post()
  criar(@Req() req: any, @Body() body: { name: string; phone?: string }) {
    return this.service.criar(req.restaurantId, body);
  }

  @Patch(':id/renovar-token')
  renovarToken(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.renovarToken(id, req.restaurantId);
  }

  @Patch(':id/toggle')
  toggle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { ativo: boolean },
    @Req() req: any,
  ) {
    return this.service.toggle(id, req.restaurantId, body.ativo);
  }

  @Patch(':pedidoId/atribuir')
  atribuir(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @Body() body: { motoboy_id: number },
    @Req() req: any,
  ) {
    return this.service.atribuir(pedidoId, req.restaurantId, body.motoboy_id);
  }
}

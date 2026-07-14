import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { MesasService } from './mesas.service';

@Controller('restaurante/mesas-cadastro')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteMesasController {
  constructor(private service: MesasService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.restaurantId);
  }

  @Post()
  criar(@Body() body: { numero: number; nome?: string }, @Req() req: any) {
    return this.service.criar(req.restaurantId, body);
  }

  @Post('lote')
  criarEmLote(@Body() body: { de: number; ate: number }, @Req() req: any) {
    return this.service.criarEmLote(req.restaurantId, body.de, body.ate);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remover(id, req.restaurantId);
  }
}

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { ImpressorasService } from './impressoras.service';
import type { ImpressoraBody } from './impressoras.service';

@Controller('restaurante/impressoras')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteImpressorasController {
  constructor(private service: ImpressorasService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.restaurantId);
  }

  @Post()
  criar(@Body() body: ImpressoraBody, @Req() req: any) {
    return this.service.criar(req.restaurantId, body);
  }

  @Patch(':id')
  atualizar(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<ImpressoraBody>, @Req() req: any) {
    return this.service.atualizar(id, req.restaurantId, body);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remover(id, req.restaurantId);
  }
}

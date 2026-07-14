import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { SalaoPdvService } from './salao-pdv.service';
import { GarconsService } from './garcons.service';

@Controller('restaurante/salao')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteSalaoController {
  constructor(
    private service: SalaoPdvService,
    private garconsService: GarconsService,
  ) {}

  @Get('garcons-online')
  garconsOnline(@Req() req: any) {
    return this.garconsService.garconsOnline(req.restaurantId);
  }

  @Get('mesas')
  mesas(@Req() req: any) {
    return this.service.mesas(req.restaurantId);
  }

  @Get('comandas')
  comandas(@Req() req: any) {
    return this.service.comandasAbertas(req.restaurantId);
  }

  @Get('comandas/:id')
  comandaDetalhe(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.comandaDetalhe(id, req.restaurantId);
  }

  @Patch('comandas/:id/desconto')
  desconto(@Param('id', ParseIntPipe) id: number, @Body() body: { valor: number }, @Req() req: any) {
    return this.service.aplicarDesconto(id, req.restaurantId, body.valor);
  }

  @Patch('comandas/:id/acrescimo')
  acrescimo(@Param('id', ParseIntPipe) id: number, @Body() body: { valor: number }, @Req() req: any) {
    return this.service.aplicarAcrescimo(id, req.restaurantId, body.valor);
  }

  @Post('comandas/:id/cancelar')
  cancelar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cancelar(id, req.restaurantId);
  }

  @Post('comandas/:id/pagar')
  pagar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { forma_pagamento: string; gorjeta_valor?: number },
    @Req() req: any,
  ) {
    return this.service.pagar(id, req.restaurantId, body.forma_pagamento, body.gorjeta_valor);
  }
}

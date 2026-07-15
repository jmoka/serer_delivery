import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { SalaoPdvService } from './salao-pdv.service';
import { GarconsService } from './garcons.service';
import type { ItemComandaBody } from './salao.service';

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

  @Post('comandas/:id/itens')
  adicionarItens(@Param('id', ParseIntPipe) id: number, @Body() body: { itens: ItemComandaBody[] }, @Req() req: any) {
    return this.service.adicionarItens(id, req.restaurantId, body.itens);
  }

  @Post('comandas/:id/pagamento')
  registrarPagamentoParcial(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { valor: number; forma_pagamento: string },
    @Req() req: any,
  ) {
    return this.service.registrarPagamentoParcial(id, req.restaurantId, body.valor, body.forma_pagamento);
  }

  @Patch('comandas/:id/pagamentos/:pagamentoId')
  editarPagamentoParcial(
    @Param('id', ParseIntPipe) id: number,
    @Param('pagamentoId', ParseIntPipe) pagamentoId: number,
    @Body() body: { valor: number; forma_pagamento: string },
    @Req() req: any,
  ) {
    return this.service.editarPagamentoParcial(id, req.restaurantId, pagamentoId, body.valor, body.forma_pagamento);
  }

  @Delete('comandas/:id/pagamentos/:pagamentoId')
  removerPagamentoParcial(
    @Param('id', ParseIntPipe) id: number,
    @Param('pagamentoId', ParseIntPipe) pagamentoId: number,
    @Req() req: any,
  ) {
    return this.service.removerPagamentoParcial(id, req.restaurantId, pagamentoId);
  }

  @Delete('comandas/:id/itens/:itemId')
  removerItem(@Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number, @Req() req: any) {
    return this.service.removerItem(id, req.restaurantId, itemId);
  }

  @Patch('comandas/:id/transferir-garcom')
  transferirGarcom(@Param('id', ParseIntPipe) id: number, @Body() body: { garcom_id: number }, @Req() req: any) {
    return this.service.transferirGarcom(id, req.restaurantId, body.garcom_id);
  }

  @Patch('comandas/:id/transferir')
  transferir(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { mesa_id?: number; comanda_destino_id?: number },
    @Req() req: any,
  ) {
    return this.service.transferir(id, req.restaurantId, body);
  }

  @Get('comandas/:id/sugestao-gorjeta')
  sugestaoGorjeta(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.sugestaoGorjeta(id, req.restaurantId);
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

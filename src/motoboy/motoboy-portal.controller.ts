import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { MotoboyGuard } from '../auth/motoboy.guard';
import { MotoboyService } from './motoboy.service';

@Controller('motoboy')
@UseGuards(MotoboyGuard)
export class MotoboyPortalController {
  constructor(private service: MotoboyService) {}

  @Get('me')
  me(@Req() req: any) {
    return this.service.infoMotoboy(req.motoboyId);
  }

  @Get('pedidos/disponiveis')
  disponiveis(@Req() req: any) {
    return this.service.pedidosDisponiveis(req.motoboyId);
  }

  @Get('pedidos')
  pedidos(@Req() req: any) {
    return this.service.meusPedidos(req.motoboyId);
  }

  @Post('pedidos/:id/pegar')
  pegar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.pegarPedido(id, req.motoboyId);
  }

  @Post('pedidos/:id/reivindicar')
  reivindicar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.reivindicarPedido(id, req.motoboyId);
  }

  @Post('pedidos/:id/confirmar-coleta')
  confirmarColeta(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { barcode: string },
    @Req() req: any,
  ) {
    return this.service.confirmarColeta(id, req.motoboyId, body.barcode);
  }

  @Patch('pedidos/:id/localizacao')
  localizacao(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { lat: number; lng: number },
    @Req() req: any,
  ) {
    return this.service.atualizarLocalizacao(id, req.motoboyId, body.lat, body.lng);
  }

  @Post('pedidos/:id/entregar')
  entregar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { entrega_pagamento?: { metodo: string; dinheiro?: number; pix?: number } },
    @Req() req: any,
  ) {
    return this.service.confirmarEntrega(id, req.motoboyId, body?.entrega_pagamento);
  }

  @Post('pedidos/:id/comprovante')
  comprovante(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { base64: string },
    @Req() req: any,
  ) {
    return this.service.uploadComprovante(id, req.motoboyId, body.base64);
  }

  @Post('pedidos/:id/ocorrencia')
  ocorrencia(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { tipo: 'pendente' | 'cancelada'; motivo: string },
    @Req() req: any,
  ) {
    return this.service.registrarOcorrencia(id, req.motoboyId, body.tipo, body.motivo);
  }
}

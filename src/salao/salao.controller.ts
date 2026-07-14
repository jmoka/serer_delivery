import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { GarcomGuard } from '../auth/garcom.guard';
import { SalaoService } from './salao.service';
import type { AbrirComandaBody, ItemComandaBody } from './salao.service';

@Controller('garcom')
@UseGuards(GarcomGuard)
export class SalaoController {
  constructor(private service: SalaoService) {}

  @Get('me')
  me(@Req() req: any) {
    return { id: req.garcomId, nome: req.garcomNome };
  }

  @Get('mesas')
  mesas(@Req() req: any) {
    return this.service.mesas(req.garcomRestaurantId);
  }

  @Get('produtos')
  produtos(@Req() req: any) {
    return this.service.produtos(req.garcomRestaurantId);
  }

  @Get('comandas')
  minhasComandas(@Req() req: any) {
    return this.service.minhasComandas(req.garcomId);
  }

  @Get('comandas/:id')
  obterComanda(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.obterComanda(id, req.garcomId);
  }

  @Post('comandas/abrir')
  abrir(@Body() body: AbrirComandaBody, @Req() req: any) {
    return this.service.abrirComanda(req.garcomId, req.garcomRestaurantId, body);
  }

  @Post('comandas/:id/itens')
  adicionarItens(@Param('id', ParseIntPipe) id: number, @Body() body: { itens: ItemComandaBody[] }, @Req() req: any) {
    return this.service.adicionarItens(id, req.garcomId, body.itens);
  }

  @Post('comandas/:id/enviar')
  enviar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.enviarItens(id, req.garcomId);
  }

  @Post('comandas/:id/fechar')
  fechar(@Param('id', ParseIntPipe) id: number, @Body() body: { forma_pagamento: string }, @Req() req: any) {
    return this.service.fecharComanda(id, req.garcomId, body.forma_pagamento);
  }
}

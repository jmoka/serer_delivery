import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { GarconsService } from './garcons.service';
import type { AtualizarGarcomBody, ComissaoConfigBody, CriarGarcomBody } from './garcons.service';

@Controller('restaurante/garcons')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteGarconsController {
  constructor(private service: GarconsService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.restaurantId);
  }

  @Get('online')
  online(@Req() req: any) {
    return this.service.garconsOnline(req.restaurantId);
  }

  @Post()
  criar(@Body() body: CriarGarcomBody, @Req() req: any) {
    return this.service.criar(req.restaurantId, body);
  }

  @Patch(':id')
  atualizar(@Param('id', ParseIntPipe) id: number, @Body() body: AtualizarGarcomBody, @Req() req: any) {
    return this.service.atualizar(id, req.restaurantId, body);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remover(id, req.restaurantId);
  }

  @Get('comissoes')
  listarComissoes(@Req() req: any) {
    return this.service.listarComissoesConfig(req.restaurantId);
  }

  @Post('comissoes')
  criarComissao(@Body() body: ComissaoConfigBody, @Req() req: any) {
    return this.service.criarComissaoConfig(req.restaurantId, body);
  }

  @Patch('comissoes/:id')
  atualizarComissao(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<ComissaoConfigBody>, @Req() req: any) {
    return this.service.atualizarComissaoConfig(id, req.restaurantId, body);
  }

  @Delete('comissoes/:id')
  removerComissao(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removerComissaoConfig(id, req.restaurantId);
  }
}

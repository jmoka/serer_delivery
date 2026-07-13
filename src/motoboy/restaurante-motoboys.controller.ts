import { Body, Controller, Param, ParseIntPipe, Patch, Post, Get, Query, Req, UseGuards } from '@nestjs/common';
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

  @Get('solicitacoes/count')
  solicitacoesCount(@Req() req: any) {
    return this.service.contarSolicitacoesPendentes(req.restaurantId);
  }

  @Get('solicitacoes')
  solicitacoes(@Query('status') status: 'pendente' | 'aceito' | 'recusado' | undefined, @Req() req: any) {
    return this.service.listarSolicitacoes(req.restaurantId, status ?? 'pendente');
  }

  @Patch('solicitacoes/:id/aceitar')
  aceitar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.aceitarSolicitacao(id, req.restaurantId);
  }

  @Patch('solicitacoes/:id/recusar')
  recusar(@Param('id', ParseIntPipe) id: number, @Body() body: { motivo?: string }, @Req() req: any) {
    return this.service.recusarSolicitacao(id, req.restaurantId, body?.motivo);
  }

  @Patch(':motoboyId/remover')
  remover(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Req() req: any) {
    return this.service.removerAfiliacao(motoboyId, req.restaurantId);
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

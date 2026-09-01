import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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

  @Patch('me')
  atualizarMe(@Body() body: { name?: string; phone?: string; foto_perfil?: string; chave_pix?: string }, @Req() req: any) {
    return this.service.atualizarPerfilMotoboy(req.motoboyId, body);
  }

  @Post('solicitar-revisao')
  solicitarRevisao(@Req() req: any) {
    return this.service.solicitarRevisaoPlataforma(req.motoboyId);
  }

  @Get('ganhos')
  ganhos(@Req() req: any) {
    return this.service.ganhosResumo(req.motoboyId);
  }

  @Get('ganhos/historico')
  ganhosHistorico(
    @Query('restaurant_id') restaurantId: string | undefined,
    @Query('de') de: string | undefined,
    @Query('ate') ate: string | undefined,
    @Req() req: any,
  ) {
    return this.service.ganhosHistorico(req.motoboyId, restaurantId ? Number(restaurantId) : undefined, de, ate);
  }

  @Get('ganhos/por-dia')
  ganhosPorDia(
    @Query('restaurant_id') restaurantId: string | undefined,
    @Query('de') de: string | undefined,
    @Query('ate') ate: string | undefined,
    @Req() req: any,
  ) {
    return this.service.ganhosPorDia(req.motoboyId, restaurantId ? Number(restaurantId) : undefined, de, ate);
  }

  // Sem restaurant_id, agrega pedidos disponíveis de TODAS as lojas afiliadas do motoboy
  // de uma vez (ver pedidosDisponiveisTodos) — é o modo usado pelo polling de alerta do
  // app, pra não perder pedido pronto de uma loja só porque outra está "ativa" no momento.
  @Get('pedidos/disponiveis')
  disponiveis(@Query('restaurant_id') restaurantId: string | undefined, @Req() req: any) {
    return restaurantId
      ? this.service.pedidosDisponiveis(req.motoboyId, Number(restaurantId))
      : this.service.pedidosDisponiveisTodos(req.motoboyId);
  }

  // Pedidos em produção (ainda sem motoboy) de todas as lojas afiliadas — motoboy demonstra
  // interesse aqui, antes do pedido ficar pronto (ver pedidosEmProducaoTodos).
  @Get('pedidos/em-producao')
  emProducao(@Req() req: any) {
    return this.service.pedidosEmProducaoTodos(req.motoboyId);
  }

  @Post('pedidos/:id/interesse')
  demonstrarInteresse(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.registrarInteresse(req.motoboyId, id);
  }

  @Delete('pedidos/:id/interesse')
  desistirInteresse(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.removerInteresse(req.motoboyId, id);
  }

  // ── Saldo e solicitação de repasse ───────────────────────────────────────────────

  @Get('saldo')
  saldo(@Req() req: any) {
    return this.service.saldoPorEstabelecimento(req.motoboyId);
  }

  @Post('repasses')
  criarRepasse(
    @Body() body: { restaurant_id: number; valor: number; nota_fiscal?: string },
    @Req() req: any,
  ) {
    return this.service.criarSolicitacaoRepasse(req.motoboyId, Number(body.restaurant_id), Number(body.valor), body.nota_fiscal);
  }

  @Get('repasses')
  minhasRepasses(@Req() req: any) {
    return this.service.minhasSolicitacoesRepasse(req.motoboyId);
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
    @Body() body: { entrega_pagamento?: { metodo: string; dinheiro?: number; pix?: number; cartao?: number } },
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

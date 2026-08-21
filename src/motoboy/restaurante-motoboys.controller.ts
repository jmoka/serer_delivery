import { Body, Controller, Delete, Param, ParseIntPipe, Patch, Post, Get, Query, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { MotoboyService } from './motoboy.service';
import type { MotoboyPeloRestauranteBody } from './motoboy.service';

@Controller('restaurante/motoboys')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteMotoboysController {
  constructor(private service: MotoboyService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.restaurantId);
  }

  // Cadastro direto de motoboy próprio do estabelecimento (não passa por
  // autocadastro/aprovação da plataforma/solicitação de afiliação).
  @Post()
  criar(@Body() body: MotoboyPeloRestauranteBody, @Req() req: any) {
    return this.service.criarPeloRestaurante(req.restaurantId, body);
  }

  @Patch(':motoboyId')
  editar(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Body() body: MotoboyPeloRestauranteBody, @Req() req: any) {
    return this.service.editarPeloRestaurante(motoboyId, req.restaurantId, body);
  }

  @Delete(':motoboyId')
  excluir(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Req() req: any) {
    return this.service.excluirPeloRestaurante(motoboyId, req.restaurantId);
  }

  @Patch(':motoboyId/bloquear')
  bloquear(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Body() body: { bloqueado: boolean }, @Req() req: any) {
    return this.service.bloquearAfiliacao(motoboyId, req.restaurantId, !!body?.bloqueado);
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

  @Patch('solicitacoes/:id/revisar')
  revisar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.revisarSolicitacao(id, req.restaurantId);
  }

  @Patch(':motoboyId/remover')
  remover(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Req() req: any) {
    return this.service.removerAfiliacao(motoboyId, req.restaurantId);
  }

  // redirectTo dinâmico a partir de quem chamou (mesmo padrão de RestaurantOwnerGuard
  // lendo Origin/Referer) — sem isso, cai no Site URL padrão do projeto Supabase.
  private redirectToDoRequest(req: any): string | undefined {
    const origem = req.headers['origin'] || req.headers['referer'];
    if (!origem) return undefined;
    const base = String(origem).replace(/\/$/, '');
    return `${base}/reset-password`;
  }

  @Post(':motoboyId/gerar-link-senha')
  gerarLinkSenha(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Req() req: any) {
    return this.service.gerarLinkRedefinicaoSenha(motoboyId, req.restaurantId, this.redirectToDoRequest(req));
  }

  @Post(':motoboyId/enviar-link-senha-email')
  enviarLinkSenhaEmail(@Param('motoboyId', ParseIntPipe) motoboyId: number, @Req() req: any) {
    return this.service.enviarLinkRedefinicaoSenhaPorEmail(motoboyId, req.restaurantId, this.redirectToDoRequest(req));
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

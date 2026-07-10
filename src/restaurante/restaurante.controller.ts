import {
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RestauranteService } from './restaurante.service';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';

@Controller('restaurante')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteController {
  constructor(private service: RestauranteService) {}

  @Get('minha-empresa')
  minhaEmpresa(@Req() req: any) {
    return this.service.minhaEmpresa(req.userId);
  }

  @Patch('minha-empresa')
  updateEmpresa(@Req() req: any, @Body() body: any) {
    return this.service.updateEmpresa(req.restaurantId, body);
  }

  @Get('pedidos')
  meusPedidos(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.meusPedidos(req.restaurantId, {
      status,
      limite: limite ? parseInt(limite) : undefined,
    });
  }

  @Patch('pedidos/:id/status')
  atualizarStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
    @Req() req: any,
  ) {
    return this.service.atualizarStatusPedido(id, req.restaurantId, body.status);
  }

  @Patch('pedidos/:id/cancelar')
  cancelarPedido(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { motivo: string },
    @Req() req: any,
  ) {
    return this.service.cancelarPedidoAdmin(req.restaurantId, id, body.motivo);
  }

  @Patch('pedidos/:id/frete-gratis')
  setFreteGratis(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    return this.service.setFreteGratis(req.restaurantId, id);
  }

  @Patch('pedidos/:id/troco')
  setTrocoPara(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { troco_para: number },
    @Req() req: any,
  ) {
    return this.service.setTrocoPara(req.restaurantId, id, body.troco_para);
  }

  @Get('produtos')
  meusProdutos(@Req() req: any) {
    return this.service.meusProdutos(req.restaurantId);
  }

  @Post('produtos')
  criarProduto(@Req() req: any, @Body() body: any) {
    return this.service.criarProduto(req.restaurantId, body);
  }

  @Patch('produtos/:id')
  editarProduto(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.service.editarProduto(id, req.restaurantId, body);
  }

  @Delete('produtos/:id')
  deletarProduto(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    return this.service.deletarProduto(id, req.restaurantId);
  }

  @Patch('produtos/:id/toggle')
  toggleProduto(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { ativo: boolean },
    @Req() req: any,
  ) {
    return this.service.toggleProduto(id, req.restaurantId, body.ativo);
  }

  @Get('categorias')
  minhasCategorias(@Req() req: any) {
    return this.service.minhasCategorias(req.restaurantId);
  }

  @Post('categorias')
  criarCategoria(@Req() req: any, @Body() body: { name: string }) {
    return this.service.criarCategoria(req.restaurantId, body);
  }

  @Delete('categorias/:id')
  deletarCategoria(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.deletarCategoria(id, req.restaurantId);
  }

  @Get('clientes')
  listarClientes(
    @Req() req: any,
    @Query('busca') busca?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.listarClientes(req.restaurantId, {
      busca,
      limite: limite ? parseInt(limite) : undefined,
    });
  }

  @Post('clientes')
  criarCliente(@Req() req: any, @Body() body: any) {
    return this.service.criarCliente(req.restaurantId, body);
  }

  @Patch('clientes/:id')
  atualizarCliente(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.service.atualizarCliente(id, req.restaurantId, body);
  }

  @Get('aparencia')
  getAparencia(@Req() req: any) {
    return this.service.getAparencia(req.restaurantId);
  }

  @Patch('aparencia')
  updateAparencia(@Req() req: any, @Body() body: any) {
    return this.service.updateAparencia(req.restaurantId, body);
  }

  @Get('config')
  getConfig(@Req() req: any) {
    return this.service.getConfig(req.restaurantId);
  }

  @Patch('config')
  updateConfig(@Req() req: any, @Body() body: any) {
    return this.service.updateConfig(req.restaurantId, body);
  }

  @Patch('status')
  toggleStatus(@Req() req: any, @Body() body: { aberto: boolean }) {
    return this.service.toggleStatus(req.restaurantId, body.aberto);
  }

  @Get('caixa')
  getCaixa(@Req() req: any) {
    return this.service.getCaixa(req.restaurantId);
  }

  @Post('caixa/abrir')
  abrirCaixa(@Req() req: any, @Body() body: { nome_operador: string; valor_inicial?: number }) {
    return this.service.abrirCaixa(req.restaurantId, body);
  }

  @Post('caixa/fechar')
  fecharCaixa(@Req() req: any, @Body() body: { dinheiro_contado?: number }) {
    return this.service.fecharCaixa(req.restaurantId, body);
  }

  @Post('caixa/:id/conferencia')
  aprovarConferencia(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.aprovarConferencia(req.restaurantId, id);
  }

  @Post('caixa/fechar-e-transferir')
  fecharComTransferencia(@Req() req: any, @Body() body: { nome_operador: string; valor_inicial?: number }) {
    return this.service.fecharComTransferencia(req.restaurantId, body);
  }

  @Get('caixa/historico')
  getCaixaHistorico(@Req() req: any) {
    return this.service.getCaixaHistorico(req.restaurantId);
  }

  @Get('caixa/:id')
  getCaixaDetalhe(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.getCaixaDetalhe(req.restaurantId, id);
  }

  @Post('caixa/saida')
  adicionarSaida(@Req() req: any, @Body() body: { descricao: string; valor: number; meio?: string }) {
    return this.service.adicionarSaida(req.restaurantId, body);
  }

  @Post('caixa/entrada')
  adicionarEntrada(@Req() req: any, @Body() body: { descricao: string; valor: number; meio?: string }) {
    return this.service.adicionarEntrada(req.restaurantId, body);
  }

  @Get('pedidos/:id/detalhe')
  buscarPedidoDetalhe(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.buscarPedidoDoRestaurante(req.restaurantId, id);
  }

  @Get('cozinha')
  cozinha(@Req() req: any) {
    return this.service.getCozinha(req.restaurantId);
  }

  @Patch('renovar-token-cozinha')
  renovarTokenCozinha(@Req() req: any) {
    return this.service.renovarTokenCozinha(req.restaurantId);
  }

  @Post('storage/setup')
  setupStorage() {
    return this.service.setupStorage();
  }

  @Post('storage/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder = 'geral',
  ) {
    return this.service.uploadImage(folder, file);
  }

  @Get('relatorio')
  relatorio(
    @Req() req: any,
    @Query('de') de: string,
    @Query('ate') ate: string,
  ) {
    return this.service.getRelatorio(req.restaurantId, de, ate);
  }

  @Get('relatorio/fretes')
  relatorioFretes(
    @Req() req: any,
    @Query('periodo') periodo: string = 'hoje',
  ) {
    return this.service.relatorioFretes(req.restaurantId, periodo as any);
  }

  // ── Combos ──────────────────────────────────────────────────────────────────

  @Get('combos')
  meusCombos(@Req() req: any) {
    return this.service.meusCombos(req.restaurantId);
  }

  @Get('combos/:id')
  getComboDetalhe(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.getComboDetalhe(id, req.restaurantId);
  }

  @Post('combos')
  criarCombo(@Req() req: any, @Body() body: any) {
    return this.service.criarCombo(req.restaurantId, body);
  }

  @Patch('combos/:id')
  editarCombo(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Body() body: any) {
    return this.service.editarCombo(id, req.restaurantId, body);
  }

  @Delete('combos/:id')
  deletarCombo(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.deletarCombo(id, req.restaurantId);
  }
}

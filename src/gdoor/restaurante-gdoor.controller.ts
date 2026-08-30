import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { ModuloGdoorGuard } from '../auth/modulo-gdoor.guard';
import { GdoorService } from './gdoor.service';

@Controller('restaurante/gdoor')
@UseGuards(RestaurantOwnerGuard, ModuloGdoorGuard)
export class RestauranteGdoorController {
  constructor(private service: GdoorService) {}

  @Post('gerar-token')
  gerarToken(@Req() req: any) {
    return this.service.gerarToken(req.restaurantId);
  }

  @Get('status')
  status(@Req() req: any) {
    return this.service.statusAgente(req.restaurantId);
  }

  @Patch('cnpj-esperado')
  salvarCnpjEsperado(@Body() body: { cnpj: string }, @Req() req: any) {
    return this.service.salvarCnpjEsperado(req.restaurantId, body.cnpj);
  }

  @Get('catalogo')
  catalogo(@Req() req: any) {
    return this.service.catalogoCompleto(req.restaurantId);
  }

  @Put('mapeamento/:productId')
  salvarMapeamento(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { codigo_gdoor: string | null; descricao_gdoor?: string },
    @Req() req: any,
  ) {
    return this.service.salvarMapeamentoProduto(req.restaurantId, productId, body.codigo_gdoor, body.descricao_gdoor);
  }

  @Patch('estoque/:codigo/bloquear')
  bloquearSync(
    @Param('codigo') codigo: string,
    @Body() body: { bloqueado: boolean },
    @Req() req: any,
  ) {
    return this.service.bloquearSync(req.restaurantId, codigo, !!body.bloqueado);
  }

  @Post('importar-de-gdoor')
  importarDeGdoor(@Body() body: { codigos: string[] }, @Req() req: any) {
    return this.service.importarDeGdoor(req.restaurantId, body.codigos ?? []);
  }

  @Post('exportar-para-gdoor')
  exportarParaGdoor(@Body() body: { product_ids: number[] }, @Req() req: any) {
    return this.service.exportarParaGdoor(req.restaurantId, body.product_ids ?? []);
  }

  @Get('exportar-para-gdoor/status')
  statusExportacao(@Req() req: any) {
    return this.service.statusExportacao(req.restaurantId);
  }

  // ── Clientes ────────────────────────────────────────────────────

  @Get('catalogo-clientes')
  catalogoClientes(@Req() req: any) {
    return this.service.catalogoClientes(req.restaurantId);
  }

  @Patch('clientes/:codigo/bloquear')
  bloquearSyncCliente(
    @Param('codigo') codigo: string,
    @Body() body: { bloqueado: boolean },
    @Req() req: any,
  ) {
    return this.service.bloquearSyncCliente(req.restaurantId, codigo, !!body.bloqueado);
  }

  @Post('importar-clientes-de-gdoor')
  importarClientesDeGdoor(@Body() body: { codigos: string[] }, @Req() req: any) {
    return this.service.importarClientesDeGdoor(req.restaurantId, body.codigos ?? []);
  }

  @Post('exportar-clientes-para-gdoor')
  exportarClientesParaGdoor(@Body() body: { customer_ids: number[] }, @Req() req: any) {
    return this.service.exportarClientesParaGdoor(req.restaurantId, body.customer_ids ?? []);
  }

  @Get('exportar-clientes-para-gdoor/status')
  statusExportacaoClientes(@Req() req: any) {
    return this.service.statusExportacaoClientes(req.restaurantId);
  }

  // ── Prevenda por pedido/comanda (botão manual + tag "Enviado GDOOR") ──

  @Get('pedido/:id/status')
  statusPedido(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.statusJobPedido(req.restaurantId, id);
  }

  @Post('pedido/:id/enviar')
  enviarPedido(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.enviarManual(req.restaurantId, id);
  }
}

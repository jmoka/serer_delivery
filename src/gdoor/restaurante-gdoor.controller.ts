import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { GdoorService } from './gdoor.service';

@Controller('restaurante/gdoor')
@UseGuards(RestaurantOwnerGuard)
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
}

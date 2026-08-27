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

  @Get('estoque')
  estoque(@Req() req: any) {
    return this.service.listarEstoque(req.restaurantId);
  }

  @Get('mapeamento')
  mapeamento(@Req() req: any) {
    return this.service.listarMapeamento(req.restaurantId);
  }

  @Put('mapeamento/:productId')
  salvarMapeamento(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() body: { codigo_gdoor: string | null; descricao_gdoor?: string },
    @Req() req: any,
  ) {
    return this.service.salvarMapeamentoProduto(req.restaurantId, productId, body.codigo_gdoor, body.descricao_gdoor);
  }
}

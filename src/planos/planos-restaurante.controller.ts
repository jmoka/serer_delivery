import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { PagarFaturaDto } from './dto/pagar-fatura.dto';
import { AtribuirAssinaturaDto } from './dto/atribuir-assinatura.dto';

@Controller('restaurante/plano')
@UseGuards(RestaurantOwnerGuard)
export class PlanosRestauranteController {
  constructor(private service: PlanosService) {}

  @Get('status')
  status(@Req() req: any) {
    return this.service.sincronizarPeriodo({ restaurantId: req.restaurantId });
  }

  @Get()
  detalhe(@Req() req: any) {
    return this.service.detalhePlanoRestaurante(req.restaurantId);
  }

  // Lista de planos disponíveis pra tela de upgrade
  @Get('disponiveis')
  disponiveis() {
    return this.service.listarPlanosAtivos();
  }

  // Dono escolhe/troca de plano (upgrade ou downgrade) na própria loja
  @Post('assinar')
  assinar(@Req() req: any, @Body() body: AtribuirAssinaturaDto) {
    return this.service.atribuirAssinatura({ restaurantId: req.restaurantId }, body.plano_id);
  }

  @Get('faturas')
  faturas(@Req() req: any) {
    return this.service.buscarAssinaturaPorRestaurante(req.restaurantId).then((r) => ({ faturas: r.faturas }));
  }

  @Get('faturas/:id')
  faturaDetalhe(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.buscarFaturaDoRestaurante(req.restaurantId, id);
  }

  @Post('faturas/:id/pagar')
  pagar(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: PagarFaturaDto) {
    return this.service.pagarFatura(req.restaurantId, id, body);
  }

  @Get('pagbank-chave-publica')
  chavePublica() {
    return this.service.buscarChavePublicaCartao();
  }

  @Post('renovar')
  renovar(@Req() req: any) {
    return this.service.renovarAgora(req.restaurantId);
  }
}

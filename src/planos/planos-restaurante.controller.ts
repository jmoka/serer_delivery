import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
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

  // Dono pede troca de plano — gera fatura do plano novo, só efetiva ao pagar
  @Post('assinar')
  assinar(@Req() req: any, @Body() body: AtribuirAssinaturaDto) {
    return this.service.iniciarTrocaPlano(req.restaurantId, body.plano_id);
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

  // Comprovante do Pix manual — mesmo padrão do checkout do cliente final
  @Post('faturas/:id/comprovante')
  uploadComprovante(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { base64: string }) {
    return this.service.uploadComprovanteFatura(req.restaurantId, id, body.base64);
  }

  @Patch('faturas/:id/pular-comprovante')
  pularComprovante(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.pularComprovanteFatura(req.restaurantId, id);
  }

  @Get('pagbank-chave-publica')
  chavePublica() {
    return this.service.buscarChavePublicaCartao();
  }

  // Como a plataforma recebe fatura (manual/pagbank) — dono consulta antes
  // de abrir o PagamentoFaturaModal, pra saber se mostra Cartão ou não.
  @Get('config-pagamento')
  configPagamento() {
    return this.service.buscarConfigPagamentoFatura();
  }

  @Post('renovar')
  renovar(@Req() req: any) {
    return this.service.renovarAgora(req.restaurantId);
  }
}

import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { MarketplaceBoostService } from './marketplace-boost.service';
import { CriarBoostDto } from './dto/criar-boost.dto';
import { PagarFaturaDto } from '../planos/dto/pagar-fatura.dto';

@Controller('restaurante/boosts')
@UseGuards(RestaurantOwnerGuard)
export class MarketplaceBoostRestauranteController {
  constructor(private service: MarketplaceBoostService) {}

  @Get('pacotes')
  pacotes() {
    return this.service.listarPacotesDisponiveis();
  }

  @Get()
  meusBoosts(@Req() req: any) {
    return this.service.meusBoosts(req.restaurantId);
  }

  @Get(':id')
  detalhe(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.buscarBoostDoRestaurante(req.restaurantId, id);
  }

  @Post()
  criar(@Req() req: any, @Body() body: CriarBoostDto) {
    return this.service.criarBoost(req.restaurantId, body.pacote_id, body.item_ids);
  }

  @Post(':id/pagar')
  pagar(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: PagarFaturaDto) {
    return this.service.pagarBoost(req.restaurantId, id, body);
  }
}

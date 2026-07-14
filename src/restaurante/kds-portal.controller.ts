import { Controller, Get, Param, ParseIntPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { RestauranteService } from './restaurante.service';

// Tela de KDS por setor (cozinha, bar, salgados...) — reaproveita o mesmo token
// estático da cozinha (x-cozinha-token), só muda o `impressora_id` filtrado.
@Controller('kds-portal')
@UseGuards(CozinhaGuard)
export class KdsPortalController {
  constructor(private service: RestauranteService) {}

  @Get('itens')
  itens(@Query('impressora_id', ParseIntPipe) impressoraId: number, @Req() req: any) {
    return this.service.getKdsSetor(req.cozinhaRestaurantId, impressoraId);
  }

  @Patch('itens/:id/pronto')
  marcarPronto(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.marcarItemPronto(id, req.cozinhaRestaurantId);
  }
}

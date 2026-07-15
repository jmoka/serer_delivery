import { Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { RestauranteService } from './restaurante.service';
import { SalaoService } from '../salao/salao.service';

// Tela de KDS por setor (cozinha, bar, salgados...) — reaproveita o mesmo token
// estático da cozinha (x-cozinha-token), só muda o `impressora_id` filtrado.
@Controller('kds-portal')
@UseGuards(CozinhaGuard)
export class KdsPortalController {
  constructor(
    private service: RestauranteService,
    private salaoService: SalaoService,
  ) {}

  @Get('itens')
  itens(@Query('impressora_id', ParseIntPipe) impressoraId: number, @Req() req: any) {
    return this.service.getKdsSetor(req.cozinhaRestaurantId, impressoraId);
  }

  @Patch('itens/:id/pronto')
  marcarPronto(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.marcarItemPronto(id, req.cozinhaRestaurantId);
  }

  @Post('comandas/:orderId/reimprimir')
  reimprimir(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Query('impressora_id', ParseIntPipe) impressoraId: number,
    @Req() req: any,
  ) {
    return this.salaoService.reimprimirGrupo(orderId, impressoraId, req.cozinhaRestaurantId);
  }
}

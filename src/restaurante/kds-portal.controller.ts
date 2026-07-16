import { Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { RestauranteService } from './restaurante.service';
import { SalaoService } from '../salao/salao.service';
import { ImpressorasService } from '../salao/impressoras.service';

// Tela de KDS por setor (cozinha, bar, salgados...) — reaproveita o mesmo token
// estático da cozinha (x-cozinha-token), só muda o `impressora_id` filtrado.
@Controller('kds-portal')
@UseGuards(CozinhaGuard)
export class KdsPortalController {
  constructor(
    private service: RestauranteService,
    private salaoService: SalaoService,
    private impressorasService: ImpressorasService,
  ) {}

  // Lista de impressoras/setores acessível pelo mesmo token de cozinha (sem precisar
  // de login de dono) — pra tela de Cozinha também poder listar/filtrar itens do salão.
  @Get('impressoras')
  impressoras(@Req() req: any) {
    return this.impressorasService.listar(req.cozinhaRestaurantId);
  }

  @Get('itens')
  itens(@Query('impressora_id', ParseIntPipe) impressoraId: number, @Req() req: any) {
    return this.service.getKdsSetor(req.cozinhaRestaurantId, impressoraId);
  }

  @Patch('itens/:id/pronto')
  marcarPronto(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.marcarItemPronto(id, req.cozinhaRestaurantId);
  }

  @Patch('itens/:id/iniciar-preparo')
  iniciarPreparo(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.iniciarPreparoItem(id, req.cozinhaRestaurantId);
  }

  @Post('itens/:id/reimprimir')
  reimprimir(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.salaoService.reimprimirItem(id, req.cozinhaRestaurantId);
  }
}

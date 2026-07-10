import { Body, Controller, Get, Param, ParseIntPipe, Patch, Req, UseGuards } from '@nestjs/common';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { RestauranteService } from './restaurante.service';

@Controller('cozinha-portal')
@UseGuards(CozinhaGuard)
export class CozinhaPortalController {
  constructor(private service: RestauranteService) {}

  @Get('me')
  me(@Req() req: any) {
    return { restaurante: { id: req.cozinhaRestaurantId, name: req.cozinhaRestaurantName } };
  }

  @Get('pedidos')
  pedidos(@Req() req: any) {
    return this.service.getCozinha(req.cozinhaRestaurantId);
  }

  @Patch('pedidos/:id/status')
  atualizarStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
    @Req() req: any,
  ) {
    return this.service.atualizarStatusPedido(id, req.cozinhaRestaurantId, body.status);
  }
}

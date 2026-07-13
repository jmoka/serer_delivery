import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { MotoboyGuard } from '../auth/motoboy.guard';
import { MotoboyService } from './motoboy.service';

@Controller('motoboy/estabelecimentos')
@UseGuards(MotoboyGuard)
export class MotoboyEstabelecimentosController {
  constructor(private service: MotoboyService) {}

  @Get()
  buscar(@Query('busca') busca: string | undefined, @Req() req: any) {
    return this.service.buscarEstabelecimentos(req.motoboyId, busca);
  }

  @Get('minhas')
  minhas(@Req() req: any) {
    return this.service.minhasAfiliacoes(req.motoboyId);
  }

  @Post(':restaurantId/solicitar')
  solicitar(@Param('restaurantId', ParseIntPipe) restaurantId: number, @Req() req: any) {
    return this.service.solicitarAfiliacao(req.motoboyId, restaurantId);
  }
}

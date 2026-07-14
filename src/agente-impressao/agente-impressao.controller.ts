import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AgenteImpressaoGuard } from '../auth/agente-impressao.guard';
import { AgenteImpressaoService } from './agente-impressao.service';

// API consumida pelo agente Python local — token de pareamento (x-agente-token),
// não usa Supabase Auth nem sessão de dono.
@Controller('agente-impressao')
@UseGuards(AgenteImpressaoGuard)
export class AgenteImpressaoController {
  constructor(private service: AgenteImpressaoService) {}

  @Get('me')
  me(@Req() req: any) {
    return { restaurante: { id: req.agenteRestaurantId, name: req.agenteRestaurantName } };
  }

  @Post('impressoras')
  reportarImpressoras(@Body() body: { impressoras: string[] }, @Req() req: any) {
    return this.service.reportarImpressoras(req.agenteRestaurantId, body.impressoras ?? []);
  }

  @Get('jobs/pendentes')
  jobsPendentes(@Req() req: any) {
    return this.service.jobsPendentes(req.agenteRestaurantId);
  }

  @Post('jobs/:id/concluido')
  marcarConcluido(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.marcarConcluido(id, req.agenteRestaurantId);
  }

  @Post('jobs/:id/erro')
  marcarErro(@Param('id', ParseIntPipe) id: number, @Body() body: { mensagem?: string }, @Req() req: any) {
    return this.service.marcarErro(id, req.agenteRestaurantId, body.mensagem ?? 'Erro desconhecido');
  }
}

import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AgenteGdoorGuard } from '../auth/agente-gdoor.guard';
import { GdoorService } from './gdoor.service';

// API consumida pelo agente Python local (api_gdoor) — token de pareamento
// (x-gdoor-agente-token), não usa Supabase Auth nem sessão de dono.
@Controller('agente-gdoor')
@UseGuards(AgenteGdoorGuard)
export class AgenteGdoorController {
  constructor(private service: GdoorService) {}

  @Get('me')
  me(@Req() req: any) {
    return { restaurante: { id: req.agenteRestaurantId, name: req.agenteRestaurantName } };
  }

  @Post('cnpj')
  registrarCnpj(@Body() body: { cnpj: string }, @Req() req: any) {
    return this.service.registrarCnpjAgente(req.agenteRestaurantId, body.cnpj);
  }

  @Get('jobs/pendentes')
  jobsPendentes(@Req() req: any) {
    return this.service.jobsPendentes(req.agenteRestaurantId, req.agenteCnpjEsperado, req.agenteCnpjConfirmado);
  }

  @Post('jobs/:id/concluido')
  marcarProcessado(@Param('id', ParseIntPipe) id: number, @Body() body: { venda_id_gdoor?: string }, @Req() req: any) {
    return this.service.marcarProcessado(id, req.agenteRestaurantId, body.venda_id_gdoor ?? '');
  }

  @Post('jobs/:id/erro')
  marcarErro(@Param('id', ParseIntPipe) id: number, @Body() body: { mensagem?: string }, @Req() req: any) {
    return this.service.marcarErro(id, req.agenteRestaurantId, body.mensagem ?? 'Erro desconhecido');
  }
}

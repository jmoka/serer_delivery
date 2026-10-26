import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { VisitasService } from './visitas.service';
import { RegistrarVisitaDto } from './visitas.dto';
import { AdminGuard } from '../auth/admin.guard';

// Atrás do Cloudflare Tunnel, req.ip não é o IP do visitante — Cloudflare
// sempre injeta CF-Connecting-IP com o IP real do cliente.
function extrairIpReal(req: Request, cfConnectingIp?: string): string {
  if (cfConnectingIp) return cfConnectingIp;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip ?? '';
}

@Controller('visitas')
export class VisitasController {
  constructor(private service: VisitasService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  registrar(
    @Body() dto: RegistrarVisitaDto,
    @Req() req: Request,
    @Headers('cf-connecting-ip') cfConnectingIp?: string,
  ) {
    const ip = extrairIpReal(req, cfConnectingIp);
    return this.service.registrar(dto, ip, req.headers['user-agent']);
  }

  // POST, não PATCH: navigator.sendBeacon (usado no pagehide, cliente saindo
  // da página) só envia POST — não dá pra trocar o verbo nesse caso.
  @Post(':id/heartbeat')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  heartbeat(@Param('id', ParseIntPipe) id: number) {
    return this.service.heartbeat(id);
  }
}

@Controller('plataforma/visitas')
@UseGuards(AdminGuard)
export class VisitasAdminController {
  constructor(private service: VisitasService) {}

  @Get()
  listar(@Query('empresa_id') empresaId?: string, @Query('limite') limite?: string) {
    return this.service.listarAdmin({
      empresa_id: empresaId ? parseInt(empresaId) : undefined,
      limite: limite ? parseInt(limite) : undefined,
    });
  }
}

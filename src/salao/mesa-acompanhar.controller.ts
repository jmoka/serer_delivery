import { Controller, Get, Param, Post } from '@nestjs/common';
import { SalaoService } from './salao.service';

// Público — QR code na mesa pra cliente acompanhar o preparo (ideia 13), sem login.
@Controller('mesa-acompanhar')
export class MesaAcompanharController {
  constructor(private service: SalaoService) {}

  @Get(':token')
  acompanhar(@Param('token') token: string) {
    return this.service.acompanharPorToken(token);
  }

  @Post(':token/imprimir-conferencia')
  imprimirConferencia(@Param('token') token: string) {
    return this.service.imprimirConferencia(token);
  }
}

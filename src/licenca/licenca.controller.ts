import { Controller, Get, Post } from '@nestjs/common';
import { LicencaService } from './licenca.service';

@Controller('licenca')
export class LicencaController {
  constructor(private service: LicencaService) {}

  @Get('status')
  status() {
    return this.service.getStatus();
  }

  // Força checkin na hora — usado depois de trocar plano/revogar no admin
  // pra não esperar o ciclo automático.
  @Post('checkin-agora')
  checkinAgora() {
    return this.service.forcarCheckin();
  }
}

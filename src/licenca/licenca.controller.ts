import { Controller, Get } from '@nestjs/common';
import { LicencaService } from './licenca.service';

@Controller('licenca')
export class LicencaController {
  constructor(private service: LicencaService) {}

  @Get('status')
  status() {
    return this.service.getStatus();
  }
}

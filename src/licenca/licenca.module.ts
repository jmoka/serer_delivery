import { Module } from '@nestjs/common';
import { LicencaService } from './licenca.service';
import { LicencaController } from './licenca.controller';

@Module({
  controllers: [LicencaController],
  providers: [LicencaService],
})
export class LicencaModule {}

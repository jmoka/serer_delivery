import { Module } from '@nestjs/common';
import { LicencaService } from './licenca.service';
import { LicencaController } from './licenca.controller';

@Module({
  controllers: [LicencaController],
  providers: [LicencaService],
  exports: [LicencaService],
})
export class LicencaModule {}

import { Module } from '@nestjs/common';
import { InstalacoesService } from './instalacoes.service';
import { InstalacoesAdminController } from './instalacoes-admin.controller';
import { InstalacoesCheckinController } from './instalacoes-checkin.controller';
import { AuthModule } from '../auth/auth.module';
import { PlanosModule } from '../planos/planos.module';

@Module({
  imports: [AuthModule, PlanosModule],
  controllers: [InstalacoesAdminController, InstalacoesCheckinController],
  providers: [InstalacoesService],
})
export class InstalacoesModule {}

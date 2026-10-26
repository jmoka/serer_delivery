import { Module } from '@nestjs/common';
import { VisitasController, VisitasAdminController } from './visitas.controller';
import { VisitasService } from './visitas.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [VisitasController, VisitasAdminController],
  providers: [VisitasService],
})
export class VisitasModule {}

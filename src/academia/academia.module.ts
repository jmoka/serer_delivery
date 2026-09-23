import { Module } from '@nestjs/common';
import {
  RestauranteAcademiaController,
  MotoboyAcademiaController,
  ClienteAcademiaController,
  AcademiaCatalogoController,
  AdminAcademiaController,
} from './academia.controller';
import { AcademiaService } from './academia.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [
    RestauranteAcademiaController,
    MotoboyAcademiaController,
    ClienteAcademiaController,
    AcademiaCatalogoController,
    AdminAcademiaController,
  ],
  providers: [AcademiaService],
})
export class AcademiaModule {}

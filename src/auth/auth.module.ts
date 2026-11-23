import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { JwtGuard } from './jwt.guard';
import { AdminGuard } from './admin.guard';
import { RestaurantOwnerGuard } from './restaurant-owner.guard';
import { MotoboyGuard } from './motoboy.guard';
import { GarcomGuard } from './garcom.guard';
import { AgenteImpressaoGuard } from './agente-impressao.guard';
import { AgenteGdoorGuard } from './agente-gdoor.guard';
import { ModuloGdoorGuard } from './modulo-gdoor.guard';
import { ModuloAssistenteIaGuard } from './modulo-assistente-ia.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  imports: [CommonModule],
  providers: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, GarcomGuard, AgenteImpressaoGuard, AgenteGdoorGuard, ModuloGdoorGuard, ModuloAssistenteIaGuard, SupabaseJwtService],
  exports: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, GarcomGuard, AgenteImpressaoGuard, AgenteGdoorGuard, ModuloGdoorGuard, ModuloAssistenteIaGuard, SupabaseJwtService],
})
export class AuthModule {}

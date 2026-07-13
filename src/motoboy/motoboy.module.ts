import { Module } from '@nestjs/common';
import { MotoboyService } from './motoboy.service';
import { MotoboyAuthService } from './motoboy-auth.service';
import { ComissaoService } from './comissao.service';
import { GeocodingService } from './geocoding.service';
import { RestauranteMotoboysController } from './restaurante-motoboys.controller';
import { MotoboyPortalController } from './motoboy-portal.controller';
import { MotoboyAuthController } from './motoboy-auth.controller';
import { MotoboyEstabelecimentosController } from './motoboy-estabelecimentos.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [
    RestauranteMotoboysController,
    MotoboyPortalController,
    MotoboyAuthController,
    MotoboyEstabelecimentosController,
  ],
  providers: [MotoboyService, MotoboyAuthService, ComissaoService, GeocodingService],
  exports: [MotoboyService, ComissaoService, GeocodingService],
})
export class MotoboyModule {}

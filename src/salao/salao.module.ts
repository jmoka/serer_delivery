import { Module } from '@nestjs/common';
import { SalaoService } from './salao.service';
import { SalaoController } from './salao.controller';
import { GarcomAuthService } from './garcom-auth.service';
import { GarcomAuthController } from './garcom-auth.controller';
import { GarconsService } from './garcons.service';
import { RestauranteGarconsController } from './restaurante-garcons.controller';
import { ImpressorasService } from './impressoras.service';
import { RestauranteImpressorasController } from './restaurante-impressoras.controller';
import { SalaoPdvService } from './salao-pdv.service';
import { RestauranteSalaoController } from './restaurante-salao.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [
    SalaoController,
    GarcomAuthController,
    RestauranteGarconsController,
    RestauranteImpressorasController,
    RestauranteSalaoController,
  ],
  providers: [SalaoService, GarcomAuthService, GarconsService, ImpressorasService, SalaoPdvService],
  exports: [SalaoService, GarconsService, ImpressorasService, SalaoPdvService],
})
export class SalaoModule {}

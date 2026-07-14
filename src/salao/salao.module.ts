import { Module } from '@nestjs/common';
import { SalaoService } from './salao.service';
import { SalaoController } from './salao.controller';
import { GarcomAuthService } from './garcom-auth.service';
import { GarcomAuthController } from './garcom-auth.controller';
import { GarconsService } from './garcons.service';
import { RestauranteGarconsController } from './restaurante-garcons.controller';
import { ImpressorasService } from './impressoras.service';
import { RestauranteImpressorasController } from './restaurante-impressoras.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [SalaoController, GarcomAuthController, RestauranteGarconsController, RestauranteImpressorasController],
  providers: [SalaoService, GarcomAuthService, GarconsService, ImpressorasService],
  exports: [SalaoService, GarconsService, ImpressorasService],
})
export class SalaoModule {}

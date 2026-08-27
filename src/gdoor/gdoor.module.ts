import { Module } from '@nestjs/common';
import { GdoorService } from './gdoor.service';
import { AgenteGdoorController } from './agente-gdoor.controller';
import { RestauranteGdoorController } from './restaurante-gdoor.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [AgenteGdoorController, RestauranteGdoorController],
  providers: [GdoorService],
  exports: [GdoorService],
})
export class GdoorModule {}

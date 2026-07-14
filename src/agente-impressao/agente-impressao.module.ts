import { Module } from '@nestjs/common';
import { AgenteImpressaoService } from './agente-impressao.service';
import { AgenteImpressaoController } from './agente-impressao.controller';
import { RestauranteAgenteImpressaoController } from './restaurante-agente-impressao.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [AgenteImpressaoController, RestauranteAgenteImpressaoController],
  providers: [AgenteImpressaoService],
  exports: [AgenteImpressaoService],
})
export class AgenteImpressaoModule {}

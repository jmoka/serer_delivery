import { Module } from '@nestjs/common';
import { ServicosService } from './servicos.service';
import { RestauranteServicosController } from './restaurante-servicos.controller';
import { ServicosPublicoController } from './servicos-publico.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { PlanosModule } from '../planos/planos.module';

@Module({
  imports: [AuthModule, SupabaseModule, PlanosModule],
  controllers: [RestauranteServicosController, ServicosPublicoController],
  providers: [ServicosService],
  exports: [ServicosService],
})
export class ServicosModule {}

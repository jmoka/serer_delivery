import { Module } from '@nestjs/common';
import { ServicosService } from './servicos.service';
import { RestauranteServicosController } from './restaurante-servicos.controller';
import { ServicosPublicoController } from './servicos-publico.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [RestauranteServicosController, ServicosPublicoController],
  providers: [ServicosService],
  exports: [ServicosService],
})
export class ServicosModule {}

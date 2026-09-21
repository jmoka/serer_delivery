import { Module } from '@nestjs/common';
import { PerfilController } from './perfil.controller';
import { PerfilService } from './perfil.service';
import { EnderecosController } from './enderecos.controller';
import { EnderecosService } from './enderecos.service';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { MotoboyModule } from '../motoboy/motoboy.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [AuthModule, SupabaseModule, MotoboyModule, TelegramModule],
  controllers: [PerfilController, EnderecosController],
  providers: [PerfilService, EnderecosService],
  exports: [PerfilService],
})
export class PerfilModule {}

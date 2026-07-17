import { Module } from '@nestjs/common';
import { PerfilController } from './perfil.controller';
import { PerfilService } from './perfil.service';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { MotoboyModule } from '../motoboy/motoboy.module';

@Module({
  imports: [AuthModule, SupabaseModule, MotoboyModule],
  controllers: [PerfilController],
  providers: [PerfilService],
  exports: [PerfilService],
})
export class PerfilModule {}

import { Module } from '@nestjs/common';
import { MotoboyAcaoLinkService } from './motoboy-acao-link.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [MotoboyAcaoLinkService],
  exports: [MotoboyAcaoLinkService],
})
export class MotoboyAcaoLinkModule {}

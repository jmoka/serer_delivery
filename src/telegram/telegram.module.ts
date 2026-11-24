import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { MotoboyAcaoLinkModule } from '../motoboy/motoboy-acao-link.module';

@Module({
  imports: [SupabaseModule, MotoboyAcaoLinkModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}

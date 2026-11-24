import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { MotoboyAcaoLinkModule } from '../motoboy/motoboy-acao-link.module';
import { PedidoTrackingLinkModule } from '../pedidos/pedido-tracking-link.module';

@Module({
  imports: [SupabaseModule, MotoboyAcaoLinkModule, PedidoTrackingLinkModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}

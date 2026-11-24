import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { MotoboyAcaoLinkModule } from '../motoboy/motoboy-acao-link.module';
import { PedidoTrackingLinkModule } from '../pedidos/pedido-tracking-link.module';

@Module({
  imports: [SupabaseModule, MotoboyAcaoLinkModule, PedidoTrackingLinkModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}

import { Module } from '@nestjs/common';
import { PedidoTrackingLinkService } from './pedido-tracking-link.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [PedidoTrackingLinkService],
  exports: [PedidoTrackingLinkService],
})
export class PedidoTrackingLinkModule {}

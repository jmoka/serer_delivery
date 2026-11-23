import { Module } from '@nestjs/common';
import { AssistenteController } from './assistente.controller';
import { AssistenteWebhookController } from './assistente-webhook.controller';
import { AssistenteService } from './assistente.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [AssistenteController, AssistenteWebhookController],
  providers: [AssistenteService],
})
export class AssistenteModule {}

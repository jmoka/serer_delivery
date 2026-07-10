import { Module } from '@nestjs/common';
import { MotoboyService } from './motoboy.service';
import { RestauranteMotoboysController } from './restaurante-motoboys.controller';
import { MotoboyPortalController } from './motoboy-portal.controller';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [RestauranteMotoboysController, MotoboyPortalController],
  providers: [MotoboyService],
  exports: [MotoboyService],
})
export class MotoboyModule {}

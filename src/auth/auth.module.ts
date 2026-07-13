import { Module } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { AdminGuard } from './admin.guard';
import { RestaurantOwnerGuard } from './restaurant-owner.guard';
import { MotoboyGuard } from './motoboy.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  providers: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, SupabaseJwtService],
  exports: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, SupabaseJwtService],
})
export class AuthModule {}

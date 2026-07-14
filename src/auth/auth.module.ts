import { Module } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { AdminGuard } from './admin.guard';
import { RestaurantOwnerGuard } from './restaurant-owner.guard';
import { MotoboyGuard } from './motoboy.guard';
import { GarcomGuard } from './garcom.guard';
import { SupabaseJwtService } from './supabase-jwt.service';

@Module({
  providers: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, GarcomGuard, SupabaseJwtService],
  exports: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard, GarcomGuard, SupabaseJwtService],
})
export class AuthModule {}

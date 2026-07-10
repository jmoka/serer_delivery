import { Module } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { AdminGuard } from './admin.guard';
import { RestaurantOwnerGuard } from './restaurant-owner.guard';
import { MotoboyGuard } from './motoboy.guard';

@Module({
  providers: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard],
  exports: [JwtGuard, AdminGuard, RestaurantOwnerGuard, MotoboyGuard],
})
export class AuthModule {}

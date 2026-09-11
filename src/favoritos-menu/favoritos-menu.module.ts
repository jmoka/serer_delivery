import { Module } from '@nestjs/common';
import { RestauranteFavoritosMenuController, AdminFavoritosMenuController } from './favoritos-menu.controller';
import { FavoritosMenuService } from './favoritos-menu.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [RestauranteFavoritosMenuController, AdminFavoritosMenuController],
  providers: [FavoritosMenuService],
})
export class FavoritosMenuModule {}

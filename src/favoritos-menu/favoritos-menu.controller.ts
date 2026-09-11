import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { FavoritosMenuService } from './favoritos-menu.service';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { AdminGuard } from '../auth/admin.guard';

interface UpdateFavoritosBody {
  paths?: string[];
  mostrar_nomes?: boolean;
}

@Controller('restaurante/favoritos-menu')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteFavoritosMenuController {
  constructor(private service: FavoritosMenuService) {}

  @Get()
  obter(@Req() req: any) {
    return this.service.obter('restaurante', req.userId);
  }

  @Patch()
  atualizar(@Req() req: any, @Body() body: UpdateFavoritosBody) {
    return this.service.atualizar('restaurante', req.userId, body);
  }
}

@Controller('admin/favoritos-menu')
@UseGuards(AdminGuard)
export class AdminFavoritosMenuController {
  constructor(private service: FavoritosMenuService) {}

  @Get()
  obter(@Req() req: any) {
    return this.service.obter('admin', req.userId);
  }

  @Patch()
  atualizar(@Req() req: any, @Body() body: UpdateFavoritosBody) {
    return this.service.atualizar('admin', req.userId, body);
  }
}

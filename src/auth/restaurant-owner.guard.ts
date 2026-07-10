import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class RestaurantOwnerGuard implements CanActivate {
  constructor(
    private jwtGuard: JwtGuard,
    private supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const userId: string = request.userId;

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) {
      throw new ForbiddenException('Nenhum restaurante vinculado a este usuário');
    }

    request.restaurantId = data.id;
    return true;
  }
}

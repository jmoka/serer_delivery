import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MotoboyGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-motoboy-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de motoboy necessário');

    const { data } = await this.supabase.client
      .from('motoboys')
      .select('id, restaurant_id, is_active, name')
      .eq('access_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');
    if (!data.is_active) throw new ForbiddenException('Motoboy inativo');

    request.motoboyId = data.id;
    request.motoboyRestaurantId = data.restaurant_id;
    request.motoboyName = data.name;
    return true;
  }
}

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class CozinhaGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-cozinha-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de cozinha necessário');

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id, name')
      .eq('cozinha_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');

    request.cozinhaRestaurantId = data.id;
    request.cozinhaRestaurantName = data.name;
    return true;
  }
}

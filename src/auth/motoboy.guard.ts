import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';

// Mesma composição de RestaurantOwnerGuard: JwtGuard identifica a conta Supabase
// (Authorization: Bearer), depois este guard resolve o motoboy dono dela.
@Injectable()
export class MotoboyGuard implements CanActivate {
  constructor(
    private jwtGuard: JwtGuard,
    private supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const userId: string = request.userId;

    const { data } = await this.supabase.client
      .from('motoboys')
      .select('id, name, is_active')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Esta conta não é de um motoboy');
    if (!data.is_active) throw new ForbiddenException('Conta desativada');

    request.motoboyId = data.id;
    request.motoboyName = data.name;
    return true;
  }
}

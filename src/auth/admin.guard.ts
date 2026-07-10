import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private jwtGuard: JwtGuard,
    private supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const userId: string = request.userId;

    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (data?.role !== 'admin') {
      throw new ForbiddenException('Acesso restrito a administradores');
    }

    return true;
  }
}

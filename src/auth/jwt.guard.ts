import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseJwtService } from './supabase-jwt.service';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private supabaseJwt: SupabaseJwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'] as string | undefined;

    if (!authHeader?.startsWith('Bearer ')) return false;

    const token = authHeader.slice(7);
    const verified = await this.supabaseJwt.verificar(token);
    if (!verified) throw new UnauthorizedException('Token JWT inválido');

    request.userId = verified.sub;
    request.userRole = verified.user_metadata?.role ?? 'customer';
    return true;
  }
}

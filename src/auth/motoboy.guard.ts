import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

export interface MotoboyJwtPayload {
  motoboyId: number;
}

@Injectable()
export class MotoboyGuard implements CanActivate {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-motoboy-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de motoboy necessário');

    // Login novo: JWT próprio assinado com MOTOBOY_JWT_SECRET.
    let payload: (jwt.JwtPayload & MotoboyJwtPayload) | null = null;
    try {
      const secret = this.config.getOrThrow('MOTOBOY_JWT_SECRET');
      payload = jwt.verify(token, secret) as jwt.JwtPayload & MotoboyJwtPayload;
    } catch {
      payload = null;
    }

    if (payload) {
      const { data } = await this.supabase.client
        .from('motoboys')
        .select('id, name, is_active, precisa_completar_cadastro')
        .eq('id', payload.motoboyId)
        .maybeSingle();

      if (!data) throw new UnauthorizedException('Motoboy não encontrado');
      if (!data.is_active) throw new ForbiddenException('Conta desativada');

      request.motoboyId = data.id;
      request.motoboyName = data.name;
      request.motoboyModoLegado = false;
      return true;
    }

    // Fallback: link/token antigo (pré-login-por-senha) — só libera completar-cadastro.
    const { data } = await this.supabase.client
      .from('motoboys')
      .select('id, name, precisa_completar_cadastro')
      .eq('access_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');
    if (!data.precisa_completar_cadastro) {
      throw new ForbiddenException('Este link não é mais válido — faça login com telefone/e-mail e senha');
    }

    request.motoboyId = data.id;
    request.motoboyName = data.name;
    request.motoboyModoLegado = true;
    return true;
  }
}

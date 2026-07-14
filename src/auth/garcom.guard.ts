import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

export interface GarcomJwtPayload {
  garcomId: number;
}

@Injectable()
export class GarcomGuard implements CanActivate {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-garcom-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de garçom necessário');

    let payload: (jwt.JwtPayload & GarcomJwtPayload) | null = null;
    try {
      const secret = this.config.getOrThrow('GARCOM_JWT_SECRET');
      payload = jwt.verify(token, secret) as jwt.JwtPayload & GarcomJwtPayload;
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado');
    }

    const { data } = await this.supabase.client
      .from('garcons')
      .select('id, restaurant_id, nome, ativo, permissoes')
      .eq('id', payload.garcomId)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Garçom não encontrado');
    if (!data.ativo) throw new ForbiddenException('Acesso desativado');

    request.garcomId = data.id;
    request.garcomNome = data.nome;
    request.garcomRestaurantId = data.restaurant_id;
    request.garcomPermissoes = data.permissoes;

    await this.supabase.client
      .from('garcons')
      .update({ ultimo_acesso_em: new Date().toISOString() })
      .eq('id', data.id);

    return true;
  }
}

import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

export interface GarcomJwtPayload {
  garcomId: number;
  sessionId: string;
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
      .select('id, restaurant_id, nome, ativo, permissoes, active_session_id, session_expires_at, restaurants(salao_modo, slug)')
      .eq('id', payload.garcomId)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Garçom não encontrado');
    if (!data.ativo) throw new ForbiddenException('Acesso desativado');

    const sessaoValida =
      data.active_session_id === payload.sessionId &&
      !!data.session_expires_at &&
      new Date(data.session_expires_at).getTime() > Date.now();
    if (!sessaoValida) throw new UnauthorizedException('Sessão encerrada. Faça login novamente.');

    // Salão (comandas/mesas) depende só do caixa estar aberto — não da loja virtual
    // (aparencia.aberto), que é o botão de delivery/site e pode ficar fechado enquanto
    // o estabelecimento atende presencial normalmente.
    const { data: caixa } = await this.supabase.client
      .from('caixas')
      .select('id')
      .eq('restaurant_id', data.restaurant_id)
      .eq('status', 'aberto')
      .maybeSingle();
    const caixaAberto = !!caixa;
    if (!caixaAberto) throw new ForbiddenException('Caixa fechado. Aguarde o caixa ser aberto para entrar.');

    request.garcomId = data.id;
    request.garcomNome = data.nome;
    request.garcomRestaurantId = data.restaurant_id;
    request.garcomRestaurantSlug = (data as any).restaurants?.slug ?? null;
    request.garcomPermissoes = data.permissoes;
    request.caixaAberto = caixaAberto;
    request.salaoModo = (data as any).restaurants?.salao_modo ?? 'ambos';

    await this.supabase.client
      .from('garcons')
      .update({ ultimo_acesso_em: new Date().toISOString() })
      .eq('id', data.id);

    return true;
  }
}

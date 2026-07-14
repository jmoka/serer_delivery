import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AgenteImpressaoGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-agente-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de agente necessário');

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id, name')
      .eq('agente_impressao_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');

    await this.supabase.client
      .from('restaurants')
      .update({ agente_impressao_ultimo_ping: new Date().toISOString() })
      .eq('id', data.id);

    request.agenteRestaurantId = data.id;
    request.agenteRestaurantName = data.name;
    return true;
  }
}

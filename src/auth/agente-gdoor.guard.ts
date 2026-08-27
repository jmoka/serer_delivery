import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// Mesmo padrão do AgenteImpressaoGuard — token vira o heartbeat automaticamente
// (atualizado a cada chamada autenticada), sem endpoint de ping dedicado.
@Injectable()
export class AgenteGdoorGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-gdoor-agente-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de agente necessário');

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id, name, gdoor_cnpj_esperado, gdoor_cnpj_confirmado')
      .eq('gdoor_agente_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');

    await this.supabase.client
      .from('restaurants')
      .update({ gdoor_agente_ultimo_ping: new Date().toISOString() })
      .eq('id', data.id);

    request.agenteRestaurantId = data.id;
    request.agenteRestaurantName = data.name;
    request.agenteCnpjEsperado = data.gdoor_cnpj_esperado;
    request.agenteCnpjConfirmado = data.gdoor_cnpj_confirmado;
    return true;
  }
}

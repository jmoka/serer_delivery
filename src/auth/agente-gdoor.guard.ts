import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
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
      .select('id, name, modulo_gdoor, gdoor_cnpj_esperado, gdoor_cnpj_confirmado')
      .eq('gdoor_agente_token', token)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');
    // Loja pode ter perdido o módulo (downgrade de plano) depois de já ter
    // pareado o agente — token continua válido, mas o agente não deve mais
    // conseguir puxar/reportar nada até o módulo voltar a ser habilitado.
    if (!data.modulo_gdoor) throw new ForbiddenException('Módulo GDOOR não está habilitado para essa loja');

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

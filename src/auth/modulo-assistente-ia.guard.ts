import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// Roda depois do RestaurantOwnerGuard (usa request.restaurantId já resolvido)
// — bloqueia as rotas do Assistente IA pro dono se o plano da loja não inclui
// esse módulo. Mesmo padrão de ModuloGdoorGuard.
@Injectable()
export class ModuloAssistenteIaGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('modulo_assistente_ia')
      .eq('id', request.restaurantId)
      .maybeSingle();

    if (!data?.modulo_assistente_ia) {
      throw new ForbiddenException('Módulo Assistente IA não está habilitado para essa loja');
    }
    return true;
  }
}

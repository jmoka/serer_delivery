import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// Roda depois do RestaurantOwnerGuard (usa request.restaurantId já resolvido)
// — bloqueia as rotas GDOOR pro dono se o plano da loja não inclui esse módulo,
// mesmo padrão de enforcement de PlanosService.verificarLimiteProdutos().
@Injectable()
export class ModuloGdoorGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('modulo_gdoor')
      .eq('id', request.restaurantId)
      .maybeSingle();

    if (!data?.modulo_gdoor) {
      throw new ForbiddenException('Módulo GDOOR não está habilitado para essa loja');
    }
    return true;
  }
}

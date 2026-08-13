import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class CozinhaGuard implements CanActivate {
  constructor(private supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-cozinha-token'] as string | undefined;

    if (!token) throw new UnauthorizedException('Token de cozinha necessário');

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id, name')
      .eq('cozinha_token', token)
      .maybeSingle();

    if (data) {
      request.cozinhaRestaurantId = data.id;
      request.cozinhaRestaurantName = data.name;
      return true;
    }

    // Token não é o geral da Cozinha — tenta como token individual de uma
    // impressora/setor, aí a sessão fica restrita àquele setor só. FK precisa
    // ser explícita: há mais de uma relação entre impressoras e restaurants
    // (dono, recibo, sangria/acréscimo), o Supabase não consegue embutir sozinho.
    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, restaurant_id, restaurants!impressoras_restaurant_id_fkey(name)')
      .eq('token', token)
      .maybeSingle();

    if (!impressora) throw new UnauthorizedException('Token inválido');

    request.cozinhaRestaurantId = impressora.restaurant_id;
    request.cozinhaRestaurantName = (impressora as any).restaurants?.name;
    request.cozinhaImpressoraId = impressora.id;
    return true;
  }
}

import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RedisService } from '../redis/redis.service';

export type EscopoFavoritos = 'restaurante' | 'admin';

export interface FavoritosEscopo {
  paths: string[];
  mostrar_nomes: boolean;
}

const PADRAO: FavoritosEscopo = { paths: [], mostrar_nomes: true };
const TTL_CACHE = 300;

// Favoritos da barra superior (pinados a partir do menu lateral) — por
// usuário, um blob por escopo ('restaurante' ou 'admin', já que o mesmo
// padrão de hook existe nos dois sidebars). Antes vivia só em localStorage
// (favoritos_restaurante_<userId>/favoritos_admin_<userId>), perdendo tudo
// ao trocar de dispositivo/navegador. Cache Redis best-effort, mesmo padrão
// de RestauranteService.minhaEmpresa — invalidado (reescrito) a cada PATCH.
@Injectable()
export class FavoritosMenuService {
  constructor(
    private supabase: SupabaseService,
    private redis: RedisService,
  ) {}

  private cacheKey(escopo: EscopoFavoritos, userId: string) {
    return `favoritos-menu:${escopo}:${userId}`;
  }

  async obter(escopo: EscopoFavoritos, userId: string): Promise<FavoritosEscopo> {
    const cacheKey = this.cacheKey(escopo, userId);
    const cached = await this.redis.getJSON<FavoritosEscopo>(cacheKey);
    if (cached) return cached;

    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('favoritos_menu')
      .eq('id', userId)
      .maybeSingle();

    const doEscopo = (data?.favoritos_menu ?? {})[escopo] ?? {};
    const resultado: FavoritosEscopo = {
      paths: Array.isArray(doEscopo.paths) ? doEscopo.paths : PADRAO.paths,
      mostrar_nomes: doEscopo.mostrar_nomes ?? PADRAO.mostrar_nomes,
    };

    await this.redis.setJSON(cacheKey, resultado, TTL_CACHE);
    return resultado;
  }

  async atualizar(
    escopo: EscopoFavoritos,
    userId: string,
    body: { paths?: string[]; mostrar_nomes?: boolean },
  ): Promise<FavoritosEscopo> {
    const { data: atual } = await this.supabase.client
      .from('user_profiles')
      .select('favoritos_menu')
      .eq('id', userId)
      .maybeSingle();

    const todos = atual?.favoritos_menu ?? {};
    const doEscopo = todos[escopo] ?? {};

    const novoEscopo: FavoritosEscopo = {
      paths: body.paths !== undefined ? body.paths : (Array.isArray(doEscopo.paths) ? doEscopo.paths : PADRAO.paths),
      mostrar_nomes: body.mostrar_nomes !== undefined ? body.mostrar_nomes : (doEscopo.mostrar_nomes ?? PADRAO.mostrar_nomes),
    };

    const { error } = await this.supabase.client
      .from('user_profiles')
      .update({ favoritos_menu: { ...todos, [escopo]: novoEscopo } })
      .eq('id', userId);
    if (error) throw error;

    await this.redis.setJSON(this.cacheKey(escopo, userId), novoEscopo, TTL_CACHE);
    return novoEscopo;
  }
}

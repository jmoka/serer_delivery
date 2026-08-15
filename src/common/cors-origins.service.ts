import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { normalizarDominio } from './dominio.util';

// Allowlist de CORS pra um SaaS multi-tenant com domínio próprio por loja
// (custom_domain): a base fixa (app principal, dev) vem de env; os domínios
// White Label vêm do banco e mudam com frequência — cache curto em memória
// evita bater no Supabase a cada preflight sem deixar a lista ficar velha.
@Injectable()
export class CorsOriginsService {
  private cache: { origens: Set<string>; expiraEm: number } | null = null;
  private readonly TTL_MS = 60_000;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  private origensBase(): string[] {
    return (this.config.get<string>('APP_ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((s) => normalizarDominio(s.trim()))
      .filter(Boolean);
  }

  private async origensDinamicas(): Promise<string[]> {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('custom_domain')
      .not('custom_domain', 'is', null)
      // aprovado = sem pendência nem recusa (ver empresas.service.ts atenderSolicitacaoDominio)
      .is('custom_domain_status', null);
    return (data ?? [])
      .map((r: { custom_domain: string }) => normalizarDominio(r.custom_domain))
      .filter(Boolean);
  }

  async estaPermitida(origin: string): Promise<boolean> {
    const dominio = normalizarDominio(origin);
    if (this.origensBase().includes(dominio)) return true;

    const agora = Date.now();
    if (!this.cache || agora > this.cache.expiraEm) {
      const dinamicas = await this.origensDinamicas();
      this.cache = { origens: new Set(dinamicas), expiraEm: agora + this.TTL_MS };
    }
    return this.cache.origens.has(dominio);
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export type SlugPaginaLegal = 'termos-de-uso' | 'politica-privacidade';

export interface PaginaLegal {
  slug: SlugPaginaLegal;
  titulo: string;
  conteudo: string;
  atualizado_em: string;
}

@Injectable()
export class PaginasLegaisService {
  constructor(private supabase: SupabaseService) {}

  async obterPorSlug(slug: string): Promise<PaginaLegal> {
    const { data, error } = await this.supabase.client
      .from('paginas_legais')
      .select('slug, titulo, conteudo, atualizado_em')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Página não encontrada');
    return data;
  }

  async listarTodas(): Promise<PaginaLegal[]> {
    const { data, error } = await this.supabase.client
      .from('paginas_legais')
      .select('slug, titulo, conteudo, atualizado_em')
      .order('slug');
    if (error) throw error;
    return data ?? [];
  }

  async atualizar(
    slug: string,
    userId: string,
    body: { titulo?: string; conteudo?: string },
  ): Promise<PaginaLegal> {
    const campos: Record<string, unknown> = { atualizado_em: new Date().toISOString(), atualizado_por: userId };
    if (body.titulo !== undefined) campos.titulo = body.titulo;
    if (body.conteudo !== undefined) campos.conteudo = body.conteudo;

    const { data, error } = await this.supabase.client
      .from('paginas_legais')
      .update(campos)
      .eq('slug', slug)
      .select('slug, titulo, conteudo, atualizado_em')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Página não encontrada');
    return data;
  }
}

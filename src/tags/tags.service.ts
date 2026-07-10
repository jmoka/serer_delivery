import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class TagsService {
  constructor(private supabase: SupabaseService) {}

  async listar(apenasAtivas = true) {
    let q = this.supabase.client.from('tags_catalogo').select('*').order('ordem').order('name');
    if (apenasAtivas) q = q.eq('ativo', true);
    const { data, error } = await q;
    if (error) throw error;
    return { tags: data ?? [] };
  }

  async criar(body: { name: string; slug: string; descricao?: string; is_auto?: boolean; ordem?: number }) {
    const { data, error } = await this.supabase.client
      .from('tags_catalogo')
      .insert({
        name: body.name,
        slug: body.slug,
        descricao: body.descricao ?? null,
        is_auto: body.is_auto ?? false,
        ordem: body.ordem ?? 0,
        ativo: true,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async atualizar(id: number, body: Partial<{ name: string; descricao: string; ordem: number; ativo: boolean }>) {
    const campos: any = {};
    if (body.name !== undefined) campos.name = body.name;
    if (body.descricao !== undefined) campos.descricao = body.descricao;
    if (body.ordem !== undefined) campos.ordem = body.ordem;
    if (body.ativo !== undefined) campos.ativo = body.ativo;

    const { data, error } = await this.supabase.client
      .from('tags_catalogo').update(campos).eq('id', id).select().single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Tag não encontrada');
    return data;
  }

  async remover(id: number) {
    const { error } = await this.supabase.client.from('tags_catalogo').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  // Retorna produtos para cada tag ativa de um restaurante
  async getCarrosseis(restaurantId: number) {
    const { tags } = await this.listar(true);
    const result: { tag: any; produtos: any[] }[] = [];

    for (const tag of tags) {
      let produtos: any[] = [];

      if (tag.slug === 'mais_vendidos') {
        // Auto: top produtos por volume de vendas
        const { data: itens } = await this.supabase.client
          .from('order_items')
          .select('product_id, quantity')
          .eq('restaurant_id', restaurantId);

        const counts: Record<number, number> = {};
        for (const i of itens ?? []) {
          counts[i.product_id] = (counts[i.product_id] ?? 0) + (i.quantity ?? 1);
        }
        const topIds = Object.entries(counts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 12)
          .map(([id]) => Number(id));

        if (topIds.length > 0) {
          const { data } = await this.supabase.client
            .from('products').select('id, name, price, preco_promo, image_url, tags, destaque, is_active')
            .in('id', topIds).eq('is_active', true);
          // Manter ordem por ranking
          const prodMap = Object.fromEntries((data ?? []).map((p: any) => [p.id, p]));
          produtos = topIds.map((id) => prodMap[id]).filter(Boolean);
        }
      } else {
        // Manual: produtos marcados com esta tag
        const { data } = await this.supabase.client
          .from('products')
          .select('id, name, price, preco_promo, image_url, tags, destaque, is_active, category_id')
          .contains('tags', [tag.slug])
          .eq('is_active', true)
          .limit(12);

        if (data) {
          // Filtrar para este restaurante via category_id
          const { data: cats } = await this.supabase.client
            .from('categories').select('id')
            .or(`restaurant_id.eq.${restaurantId},restaurant_id.is.null`);
          const catIds = new Set((cats ?? []).map((c: any) => c.id));
          produtos = data.filter((p: any) => catIds.has(p.category_id));
        }
      }

      if (produtos.length > 0) result.push({ tag, produtos });
    }

    return result;
  }
}

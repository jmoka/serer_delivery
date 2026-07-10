import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class ProdutosService {
  constructor(private supabase: SupabaseService) {}

  async listarPorEmpresa(empresaId: number, apenasAtivos?: boolean) {
    // Busca category_ids da empresa
    const { data: cats } = await this.supabase.client
      .from('categories')
      .select('id')
      .eq('restaurant_id', empresaId);

    const catIds = (cats ?? []).map((c) => c.id);
    if (catIds.length === 0) return { produtos: [], total: 0 };

    let query = this.supabase.client
      .from('products')
      .select('id, name, description, price, image_url, is_active, category_id, created_at')
      .in('category_id', catIds)
      .order('name');

    if (apenasAtivos) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;
    return { produtos: data, total: data?.length ?? 0 };
  }

  async buscar(id: number) {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('id, name, description, price, image_url, is_active, category_id, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Produto ${id} não encontrado`);
    return data;
  }

  async criar(body: {
    name: string;
    description?: string;
    price: number;
    image_url?: string;
    category_id: number;
  }) {
    const { data, error } = await this.supabase.client
      .from('products')
      .insert({
        name: body.name,
        description: body.description ?? null,
        price: body.price,
        image_url: body.image_url ?? null,
        category_id: body.category_id,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async atualizar(id: number, body: Partial<{
    name: string;
    description: string;
    price: number;
    image_url: string;
    category_id: number;
  }>) {
    const { data, error } = await this.supabase.client
      .from('products')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Produto ${id} não encontrado`);
    return data;
  }

  async toggleAtivo(id: number, ativo: boolean) {
    const { data, error } = await this.supabase.client
      .from('products')
      .update({ is_active: ativo, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, is_active')
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Produto ${id} não encontrado`);
    return data;
  }

  async remover(id: number) {
    const { error } = await this.supabase.client
      .from('products')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { mensagem: `Produto ${id} removido` };
  }
}

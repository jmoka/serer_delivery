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
      .select('id, name, description, price, image_url, is_active, category_id, impressora_id, created_at')
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
      .select('id, name, description, price, image_url, is_active, category_id, impressora_id, created_at')
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
    impressora_id?: number;
  }) {
    const { data, error } = await this.supabase.client
      .from('products')
      .insert({
        name: body.name,
        description: body.description ?? null,
        price: body.price,
        image_url: body.image_url ?? null,
        category_id: body.category_id,
        impressora_id: body.impressora_id ?? null,
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
    impressora_id: number | null;
  }>) {
    // body vem de @Body() body: any no controller (admin-only, mas ainda assim
    // nunca repassar cru) — whitelist campo a campo, igual ao padrão usado em
    // impressoras.service.ts atualizar().
    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) campos.name = body.name;
    if (body.description !== undefined) campos.description = body.description;
    if (body.price !== undefined) campos.price = body.price;
    if (body.image_url !== undefined) campos.image_url = body.image_url;
    if (body.category_id !== undefined) campos.category_id = body.category_id;
    if (body.impressora_id !== undefined) campos.impressora_id = body.impressora_id;

    const { data, error } = await this.supabase.client
      .from('products')
      .update(campos)
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

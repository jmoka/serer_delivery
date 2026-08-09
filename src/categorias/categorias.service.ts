import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class CategoriasService {
  constructor(private supabase: SupabaseService) {}

  private async garantirNomeGlobalUnico(name: string, ignorarId?: number) {
    let query = this.supabase.client
      .from('categories')
      .select('id')
      .is('restaurant_id', null)
      .ilike('name', name.trim());

    if (ignorarId) query = query.neq('id', ignorarId);

    const { data, error } = await query;
    if (error) throw error;
    if (data && data.length > 0) {
      throw new ConflictException(`Já existe uma categoria chamada "${name.trim()}"`);
    }
  }

  async listarGlobais() {
    const { data, error } = await this.supabase.client
      .from('categories')
      .select('id, name, icon_name, color_primary, color_secondary, created_at')
      .is('restaurant_id', null)
      .order('name');

    if (error) throw error;

    const catIds = (data ?? []).map((c) => c.id);
    let prodCount: Record<number, number> = {};

    if (catIds.length > 0) {
      const { data: prods } = await this.supabase.client
        .from('products')
        .select('category_id')
        .in('category_id', catIds);

      for (const p of prods ?? []) {
        prodCount[p.category_id] = (prodCount[p.category_id] ?? 0) + 1;
      }
    }

    return {
      categorias: (data ?? []).map((c) => ({ ...c, total_produtos: prodCount[c.id] ?? 0 })),
      total: data?.length ?? 0,
    };
  }

  async listarTiposEstabelecimento() {
    const { data, error } = await this.supabase.client
      .from('establishment_types')
      .select('id, name, icon_name')
      .order('name');

    if (error) throw error;
    return { tipos: data ?? [] };
  }

  private async garantirNomeTipoUnico(name: string, ignorarId?: number) {
    let query = this.supabase.client.from('establishment_types').select('id').ilike('name', name.trim());
    if (ignorarId) query = query.neq('id', ignorarId);
    const { data, error } = await query;
    if (error) throw error;
    if (data && data.length > 0) {
      throw new ConflictException(`Já existe um tipo de estabelecimento chamado "${name.trim()}"`);
    }
  }

  async criarTipoEstabelecimento(body: { name: string; icon_name?: string }) {
    await this.garantirNomeTipoUnico(body.name);

    const { data, error } = await this.supabase.client
      .from('establishment_types')
      .insert({ name: body.name, icon_name: body.icon_name ?? 'Store' })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async atualizarTipoEstabelecimento(id: number, body: { name?: string; icon_name?: string }) {
    if (body.name !== undefined) await this.garantirNomeTipoUnico(body.name, id);

    const campos: Record<string, any> = {};
    if (body.name !== undefined) campos.name = body.name;
    if (body.icon_name !== undefined) campos.icon_name = body.icon_name;

    const { data, error } = await this.supabase.client
      .from('establishment_types')
      .update(campos)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Tipo de estabelecimento ${id} não encontrado`);
    return data;
  }

  async removerTipoEstabelecimento(id: number) {
    const { error } = await this.supabase.client
      .from('establishment_types')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { mensagem: `Tipo de estabelecimento ${id} removido` };
  }

  async listarPorEmpresa(empresaId: number) {
    const { data, error } = await this.supabase.client
      .from('categories')
      .select('id, name, icon_name, color_primary, color_secondary, restaurant_id, created_at')
      .eq('restaurant_id', empresaId)
      .order('name');

    if (error) throw error;

    const catIds = (data ?? []).map((c) => c.id);
    let prodCount: Record<number, number> = {};

    if (catIds.length > 0) {
      const { data: prods } = await this.supabase.client
        .from('products')
        .select('category_id')
        .in('category_id', catIds);

      for (const p of prods ?? []) {
        prodCount[p.category_id] = (prodCount[p.category_id] ?? 0) + 1;
      }
    }

    return {
      categorias: (data ?? []).map((c) => ({ ...c, total_produtos: prodCount[c.id] ?? 0 })),
      total: data?.length ?? 0,
    };
  }

  async criarGlobal(body: { name: string; icon_name: string; color_primary: string; color_secondary: string }) {
    await this.garantirNomeGlobalUnico(body.name);

    const { data, error } = await this.supabase.client
      .from('categories')
      .insert({
        name: body.name,
        icon_name: body.icon_name,
        color_primary: body.color_primary,
        color_secondary: body.color_secondary,
        restaurant_id: null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async criar(body: { name: string; restaurant_id: number }) {
    const { data, error } = await this.supabase.client
      .from('categories')
      .insert({ name: body.name, restaurant_id: body.restaurant_id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async atualizarGlobal(id: number, body: { name?: string; icon_name?: string; color_primary?: string; color_secondary?: string }) {
    if (body.name !== undefined) await this.garantirNomeGlobalUnico(body.name, id);

    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) campos.name = body.name;
    if (body.icon_name !== undefined) campos.icon_name = body.icon_name;
    if (body.color_primary !== undefined) campos.color_primary = body.color_primary;
    if (body.color_secondary !== undefined) campos.color_secondary = body.color_secondary;

    const { data, error } = await this.supabase.client
      .from('categories')
      .update(campos)
      .eq('id', id)
      .is('restaurant_id', null)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Categoria ${id} não encontrada`);
    return data;
  }

  async atualizar(id: number, body: { name: string }) {
    const { data, error } = await this.supabase.client
      .from('categories')
      .update({ name: body.name, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Categoria ${id} não encontrada`);
    return data;
  }

  async remover(id: number) {
    const { error } = await this.supabase.client
      .from('categories')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { mensagem: `Categoria ${id} removida` };
  }
}

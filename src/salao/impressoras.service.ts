import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface ImpressoraBody {
  nome: string;
  setor: string;
  tipo_conexao: 'local' | 'rede';
  endereco?: string;
  ativo?: boolean;
  nome_sistema?: string;
}

@Injectable()
export class ImpressorasService {
  constructor(private supabase: SupabaseService) {}

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('impressoras')
      .select('id, nome, setor, tipo_conexao, endereco, ativo, nome_sistema, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  }

  async criar(restaurantId: number, body: ImpressoraBody) {
    if (!body.nome || !body.setor) throw new BadRequestException('Nome e setor são obrigatórios');

    const { data, error } = await this.supabase.client
      .from('impressoras')
      .insert({
        restaurant_id: restaurantId,
        nome: body.nome,
        setor: body.setor,
        tipo_conexao: body.tipo_conexao ?? 'rede',
        endereco: body.endereco ?? null,
        nome_sistema: body.nome_sistema ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  private async garantirPertence(id: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('impressoras')
      .select('id')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Impressora não encontrada');
  }

  async atualizar(id: number, restaurantId: number, body: Partial<ImpressoraBody>) {
    await this.garantirPertence(id, restaurantId);
    const { data, error } = await this.supabase.client
      .from('impressoras')
      .update(body)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async remover(id: number, restaurantId: number) {
    await this.garantirPertence(id, restaurantId);
    const { error } = await this.supabase.client.from('impressoras').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
}

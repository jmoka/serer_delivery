import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MesasService {
  constructor(private supabase: SupabaseService) {}

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('mesas')
      .select('id, numero, nome, status')
      .eq('restaurant_id', restaurantId)
      .order('numero', { ascending: true });
    if (error) throw error;
    return data;
  }

  async criar(restaurantId: number, body: { numero: number; nome?: string }) {
    if (!body.numero) throw new BadRequestException('Número da mesa é obrigatório');

    const { data: existente } = await this.supabase.client
      .from('mesas')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('numero', body.numero)
      .maybeSingle();
    if (existente) throw new ConflictException('Já existe uma mesa com esse número');

    const { data, error } = await this.supabase.client
      .from('mesas')
      .insert({ restaurant_id: restaurantId, numero: body.numero, nome: body.nome ?? null })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async remover(id: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('mesas')
      .select('id, status')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Mesa não encontrada');
    if (data.status !== 'livre') throw new BadRequestException('Só é possível remover mesas livres');

    const { error } = await this.supabase.client.from('mesas').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
}

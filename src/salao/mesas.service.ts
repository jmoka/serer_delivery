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

  // Cadastro em lote — pra estabelecimento com mesas fixas numeradas (ex: 1 a 20 de uma vez).
  // Pula números que já existem em vez de dar erro, pra poder rodar de novo sem medo.
  async criarEmLote(restaurantId: number, de: number, ate: number) {
    if (!de || !ate) throw new BadRequestException('Informe o número inicial e final');
    if (de > ate) throw new BadRequestException('Número inicial não pode ser maior que o final');
    if (ate - de > 200) throw new BadRequestException('Máximo de 200 mesas por lote');

    const { data: existentes } = await this.supabase.client
      .from('mesas')
      .select('numero')
      .eq('restaurant_id', restaurantId)
      .gte('numero', de)
      .lte('numero', ate);
    const jaExistem = new Set((existentes ?? []).map((m: any) => m.numero));

    const novos: number[] = [];
    for (let n = de; n <= ate; n++) {
      if (!jaExistem.has(n)) novos.push(n);
    }

    if (novos.length) {
      const { error } = await this.supabase.client
        .from('mesas')
        .insert(novos.map((numero) => ({ restaurant_id: restaurantId, numero })));
      if (error) throw error;
    }

    return { criadas: novos.length, ja_existiam: jaExistem.size };
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

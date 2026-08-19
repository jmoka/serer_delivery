import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface ImpressoraBody {
  nome: string;
  setor: string;
  tipo_conexao: 'local' | 'rede';
  endereco?: string;
  ativo?: boolean;
  nome_sistema?: string;
  ponto_preparo?: boolean;
  icone?: string;
}

@Injectable()
export class ImpressorasService {
  constructor(private supabase: SupabaseService) {}

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('impressoras')
      .select('id, nome, setor, tipo_conexao, endereco, ativo, nome_sistema, token, ponto_preparo, icone, created_at')
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
        ponto_preparo: body.ponto_preparo ?? false,
        icone: body.icone ?? 'ChefHat',
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

    // Nunca repassar o body cru pro .update() — ImpressoraBody é interface, não
    // DTO validado, então um campo extra (ex. restaurant_id, token) no corpo da
    // requisição iria direto pro banco. Whitelist campo a campo, igual a criar().
    const campos: Record<string, any> = {};
    if (body.nome !== undefined) campos.nome = body.nome;
    if (body.setor !== undefined) campos.setor = body.setor;
    if (body.tipo_conexao !== undefined) campos.tipo_conexao = body.tipo_conexao;
    if (body.endereco !== undefined) campos.endereco = body.endereco;
    if (body.ativo !== undefined) campos.ativo = body.ativo;
    if (body.nome_sistema !== undefined) campos.nome_sistema = body.nome_sistema;
    if (body.ponto_preparo !== undefined) campos.ponto_preparo = body.ponto_preparo;
    if (body.icone !== undefined) campos.icone = body.icone;

    const { data, error } = await this.supabase.client
      .from('impressoras')
      .update(campos)
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

  // Gera um token novo pra essa impressora/setor sem mexer no token das demais
  // (cada tablet/tela de setor tem sua própria sessão de acesso ao KDS).
  async renovarToken(id: number, restaurantId: number) {
    await this.garantirPertence(id, restaurantId);
    const novoToken = crypto.randomUUID();
    const { data, error } = await this.supabase.client
      .from('impressoras')
      .update({ token: novoToken })
      .eq('id', id)
      .select('id, token')
      .single();
    if (error) throw error;
    return data;
  }
}

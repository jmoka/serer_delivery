import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../supabase/supabase.service';

export interface CriarGarcomBody {
  nome: string;
  telefone?: string;
  senha: string;
  permissoes?: { desconto?: boolean; cancelar?: boolean; acrescimo?: boolean };
}

export interface AtualizarGarcomBody {
  nome?: string;
  telefone?: string;
  ativo?: boolean;
  senha?: string;
  permissoes?: { desconto?: boolean; cancelar?: boolean; acrescimo?: boolean };
}

@Injectable()
export class GarconsService {
  constructor(private supabase: SupabaseService) {}

  private gerarLoginKey(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  async criar(restaurantId: number, body: CriarGarcomBody) {
    if (!body.nome) throw new BadRequestException('Nome é obrigatório');
    if (!body.senha || body.senha.length < 4) throw new BadRequestException('Senha deve ter no mínimo 4 caracteres');

    const passwordHash = await bcrypt.hash(body.senha, 10);
    let loginKey = this.gerarLoginKey();

    for (let tentativas = 0; tentativas < 5; tentativas++) {
      const { data: existente } = await this.supabase.client
        .from('garcons')
        .select('id')
        .eq('login_key', loginKey)
        .maybeSingle();
      if (!existente) break;
      loginKey = this.gerarLoginKey();
    }

    const { data, error } = await this.supabase.client
      .from('garcons')
      .insert({
        restaurant_id: restaurantId,
        nome: body.nome,
        telefone: body.telefone ?? null,
        login_key: loginKey,
        password_hash: passwordHash,
        permissoes: {
          desconto: !!body.permissoes?.desconto,
          cancelar: !!body.permissoes?.cancelar,
          acrescimo: !!body.permissoes?.acrescimo,
        },
      })
      .select('id, nome, telefone, login_key, ativo, permissoes, created_at')
      .single();
    if (error) throw error;

    return data;
  }

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('garcons')
      .select('id, nome, telefone, login_key, ativo, permissoes, ultimo_acesso_em, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  private async garantirPertence(id: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('garcons')
      .select('id')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Garçom não encontrado');
  }

  async atualizar(id: number, restaurantId: number, body: AtualizarGarcomBody) {
    await this.garantirPertence(id, restaurantId);

    const update: Record<string, unknown> = {};
    if (body.nome !== undefined) update.nome = body.nome;
    if (body.telefone !== undefined) update.telefone = body.telefone;
    if (body.ativo !== undefined) update.ativo = body.ativo;
    if (body.permissoes !== undefined) {
      update.permissoes = {
        desconto: !!body.permissoes.desconto,
        cancelar: !!body.permissoes.cancelar,
        acrescimo: !!body.permissoes.acrescimo,
      };
    }
    if (body.senha) {
      if (body.senha.length < 4) throw new BadRequestException('Senha deve ter no mínimo 4 caracteres');
      update.password_hash = await bcrypt.hash(body.senha, 10);
    }

    const { data, error } = await this.supabase.client
      .from('garcons')
      .update(update)
      .eq('id', id)
      .select('id, nome, telefone, login_key, ativo, permissoes, created_at')
      .single();
    if (error) throw error;

    return data;
  }

  async remover(id: number, restaurantId: number) {
    await this.garantirPertence(id, restaurantId);
    const { error } = await this.supabase.client.from('garcons').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  async garconsOnline(restaurantId: number) {
    const limite = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase.client
      .from('garcons')
      .select('id, nome, ultimo_acesso_em')
      .eq('restaurant_id', restaurantId)
      .eq('ativo', true)
      .gte('ultimo_acesso_em', limite);
    if (error) throw error;
    return data;
  }
}

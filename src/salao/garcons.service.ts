import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../supabase/supabase.service';

export interface CriarGarcomBody {
  nome: string;
  telefone?: string;
  senha: string;
  permissoes?: { pagamento_parcial?: boolean };
}

export interface AtualizarGarcomBody {
  nome?: string;
  telefone?: string;
  ativo?: boolean;
  senha?: string;
  permissoes?: { pagamento_parcial?: boolean };
}

export interface ComissaoConfigBody {
  nome: string;
  tipo: 'percentual' | 'fixo';
  valor: number;
  base_calculo?: 'total_vendido' | 'total_recebido';
  ativo?: boolean;
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
          // Default true — pagamento parcial já era permitido sem restrição antes dessa
          // permissão existir, então continua liberado por padrão.
          pagamento_parcial: body.permissoes?.pagamento_parcial !== false,
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
        pagamento_parcial: body.permissoes.pagamento_parcial !== false,
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

  // Regras de comissão são do estabelecimento (não por garçom) — todo garçom que fecha
  // uma comanda gera lançamento pra cada regra ativa (ver lancarComissoes no salao-pdv.service).
  async listarComissoesConfig(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('garcom_comissoes_config')
      .select('id, nome, tipo, valor, base_calculo, ativo, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async criarComissaoConfig(restaurantId: number, body: ComissaoConfigBody) {
    if (!body.nome) throw new BadRequestException('Nome é obrigatório');
    if (!body.tipo || !['percentual', 'fixo'].includes(body.tipo)) throw new BadRequestException('Tipo inválido');
    if (body.valor === undefined || body.valor === null || body.valor < 0) throw new BadRequestException('Valor inválido');

    const { data, error } = await this.supabase.client
      .from('garcom_comissoes_config')
      .insert({
        restaurant_id: restaurantId,
        nome: body.nome,
        tipo: body.tipo,
        valor: body.valor,
        base_calculo: body.base_calculo ?? 'total_vendido',
        ativo: body.ativo !== false,
      })
      .select('id, nome, tipo, valor, base_calculo, ativo, created_at')
      .single();
    if (error) throw error;
    return data;
  }

  private async garantirComissaoConfigPertence(id: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('garcom_comissoes_config')
      .select('id')
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Regra de comissão não encontrada');
  }

  async atualizarComissaoConfig(id: number, restaurantId: number, body: Partial<ComissaoConfigBody>) {
    await this.garantirComissaoConfigPertence(id, restaurantId);

    const update: Record<string, unknown> = {};
    if (body.nome !== undefined) update.nome = body.nome;
    if (body.tipo !== undefined) {
      if (!['percentual', 'fixo'].includes(body.tipo)) throw new BadRequestException('Tipo inválido');
      update.tipo = body.tipo;
    }
    if (body.valor !== undefined) {
      if (body.valor < 0) throw new BadRequestException('Valor inválido');
      update.valor = body.valor;
    }
    if (body.base_calculo !== undefined) update.base_calculo = body.base_calculo;
    if (body.ativo !== undefined) update.ativo = body.ativo;

    const { data, error } = await this.supabase.client
      .from('garcom_comissoes_config')
      .update(update)
      .eq('id', id)
      .select('id, nome, tipo, valor, base_calculo, ativo, created_at')
      .single();
    if (error) throw error;
    return data;
  }

  async removerComissaoConfig(id: number, restaurantId: number) {
    await this.garantirComissaoConfigPertence(id, restaurantId);
    const { error } = await this.supabase.client.from('garcom_comissoes_config').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }
}

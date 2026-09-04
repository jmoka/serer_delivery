import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface ServicoBody {
  name?: string;
  description?: string;
  image_url?: string;
  categoria?: string;
  preco_min?: number;
  preco_max?: number;
  is_active?: boolean;
}

export interface SolicitarOrcamentoBody {
  nome_cliente: string;
  telefone_cliente: string;
  mensagem?: string;
}

const SERVICO_FIELDS = 'id, name, description, image_url, categoria, preco_min, preco_max, is_active, restaurant_id, created_at, updated_at';

@Injectable()
export class ServicosService {
  constructor(private supabase: SupabaseService) {}

  private validarFaixaPreco(body: ServicoBody) {
    if (body.preco_min != null && body.preco_max != null && body.preco_min > body.preco_max) {
      throw new BadRequestException('Preço mínimo não pode ser maior que o preço máximo');
    }
  }

  private async verificarServicoDoRestaurante(id: number, restaurantId: number) {
    const { data: servico } = await this.supabase.client
      .from('services').select('id, restaurant_id').eq('id', id).maybeSingle();
    if (!servico) throw new NotFoundException('Serviço não encontrado');
    if (servico.restaurant_id !== restaurantId) throw new NotFoundException('Serviço não pertence a este restaurante');
    return servico;
  }

  async listarMeusServicos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('services')
      .select(SERVICO_FIELDS)
      .eq('restaurant_id', restaurantId)
      .order('name');
    if (error) throw error;
    return { servicos: data ?? [] };
  }

  async listarServicosAtivos(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('services')
      .select(SERVICO_FIELDS)
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data ?? [];
  }

  async criarServico(restaurantId: number, body: ServicoBody) {
    if (!body.name?.trim()) throw new BadRequestException('Informe o nome do serviço');
    this.validarFaixaPreco(body);

    const { data, error } = await this.supabase.client
      .from('services')
      .insert({
        name: body.name.trim(),
        description: body.description ?? null,
        image_url: body.image_url ?? null,
        categoria: body.categoria ?? null,
        preco_min: body.preco_min ?? null,
        preco_max: body.preco_max ?? null,
        restaurant_id: restaurantId,
        is_active: true,
      })
      .select(SERVICO_FIELDS)
      .single();
    if (error) throw error;
    return data;
  }

  async editarServico(id: number, restaurantId: number, body: ServicoBody) {
    await this.verificarServicoDoRestaurante(id, restaurantId);
    this.validarFaixaPreco(body);

    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) campos.name = body.name.trim();
    if (body.description !== undefined) campos.description = body.description;
    if (body.image_url !== undefined) campos.image_url = body.image_url;
    if (body.categoria !== undefined) campos.categoria = body.categoria;
    if (body.preco_min !== undefined) campos.preco_min = body.preco_min;
    if (body.preco_max !== undefined) campos.preco_max = body.preco_max;
    if (body.is_active !== undefined) campos.is_active = body.is_active;

    const { data, error } = await this.supabase.client
      .from('services')
      .update(campos)
      .eq('id', id)
      .select(SERVICO_FIELDS)
      .single();
    if (error) throw error;
    return data;
  }

  async deletarServico(id: number, restaurantId: number) {
    await this.verificarServicoDoRestaurante(id, restaurantId);
    const { error } = await this.supabase.client.from('services').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  async toggleServico(id: number, restaurantId: number, ativo: boolean) {
    await this.verificarServicoDoRestaurante(id, restaurantId);
    const { data, error } = await this.supabase.client
      .from('services')
      .update({ is_active: ativo, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(SERVICO_FIELDS)
      .single();
    if (error) throw error;
    return data;
  }

  // Endpoint público (vitrine, sem login) — valida que o serviço pertence mesmo
  // ao restaurante do slug antes de gravar (evita solicitação "vazando" pra
  // outro restaurante se o serviceId informado for de outra loja).
  async criarSolicitacaoOrcamento(restaurantId: number, serviceId: number, body: SolicitarOrcamentoBody) {
    const { data: servico } = await this.supabase.client
      .from('services').select('id, restaurant_id, is_active').eq('id', serviceId).maybeSingle();
    if (!servico || servico.restaurant_id !== restaurantId || !servico.is_active) {
      throw new NotFoundException('Serviço não encontrado');
    }

    const { data, error } = await this.supabase.client
      .from('solicitacoes_orcamento_servico')
      .insert({
        service_id: serviceId,
        restaurant_id: restaurantId,
        nome_cliente: body.nome_cliente.trim(),
        telefone_cliente: body.telefone_cliente.trim(),
        mensagem: body.mensagem?.trim() || null,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listarSolicitacoes(restaurantId: number, status?: 'pendente' | 'contatado') {
    let q = this.supabase.client
      .from('solicitacoes_orcamento_servico')
      .select('id, service_id, nome_cliente, telefone_cliente, mensagem, status, criado_em, contatado_em, services(name)')
      .eq('restaurant_id', restaurantId)
      .order('criado_em', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return {
      solicitacoes: (data ?? []).map((s: any) => ({ ...s, servico_nome: s.services?.name ?? null, services: undefined })),
    };
  }

  async contarSolicitacoesPendentes(restaurantId: number) {
    const { count, error } = await this.supabase.client
      .from('solicitacoes_orcamento_servico')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente');
    if (error) throw error;
    return { count: count ?? 0 };
  }

  async marcarComoContatado(id: number, restaurantId: number) {
    const { data: solicitacao } = await this.supabase.client
      .from('solicitacoes_orcamento_servico').select('id, restaurant_id').eq('id', id).maybeSingle();
    if (!solicitacao || solicitacao.restaurant_id !== restaurantId) throw new NotFoundException('Solicitação não encontrada');

    const { data, error } = await this.supabase.client
      .from('solicitacoes_orcamento_servico')
      .update({ status: 'contatado', contatado_em: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

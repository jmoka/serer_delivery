import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UsuariosService } from '../usuarios/usuarios.service';

@Injectable()
export class EmpresasService {
  constructor(
    private supabase: SupabaseService,
    private usuarios: UsuariosService,
  ) {}

  private gerarSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').trim();
  }

  async listar(apenasAtivo?: boolean) {
    let query = this.supabase.client
      .from('restaurants')
      .select('id, name, address, logo_url, comissao_pct, user_id, slug, bloqueado, custom_domain, custom_domain_status, custom_domain_solicitado_em, custom_domain_motivo_recusa, modulo_delivery, modulo_salao, created_at')
      .order('name');

    const { data, error } = await query;
    if (error) throw error;
    return { empresas: data, total: data?.length ?? 0 };
  }

  async buscar(id: number) {
    // payment_config nunca sai daqui em claro — tem rota própria mascarada
    // (GET /empresas/:id/config, ver empresas.controller.ts).
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .select('id, name, address, logo_url, business_hours, comissao_pct, user_id, slug, modulo_delivery, modulo_salao, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Empresa ${id} não encontrada`);

    const [{ data: metricas }, { data: platData }] = await Promise.all([
      this.supabase.client.from('orders').select('id, total, status').eq('restaurant_id', id),
      this.supabase.client.from('platform_settings').select('config').eq('id', 1).maybeSingle(),
    ]);

    const entregues = (metricas ?? []).filter((p) => p.status === 'delivered');
    const faturamento = entregues.reduce((acc, p) => acc + (p.total ?? 0), 0);
    const platCfg = (platData?.config ?? {}) as Record<string, any>;
    const comissaoPct = data.comissao_pct ?? platCfg.comissao_padrao_pct ?? 5;

    return {
      empresa: data,
      metricas: {
        total_pedidos: metricas?.length ?? 0,
        pedidos_entregues: entregues.length,
        faturamento,
        comissao_acumulada: parseFloat((faturamento * (comissaoPct / 100)).toFixed(2)),
      },
    };
  }

  async criar(body: {
    name: string;
    address?: string;
    logo_url?: string;
    comissao_pct?: number;
    user_id?: string;
    slug?: string;
    modulo_delivery?: boolean;
    modulo_salao?: boolean;
  }) {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .insert({
        name: body.name,
        address: body.address ?? null,
        logo_url: body.logo_url ?? null,
        comissao_pct: body.comissao_pct ?? null,
        user_id: body.user_id || null,
        slug: body.slug || this.gerarSlug(body.name),
        modulo_delivery: body.modulo_delivery ?? true,
        modulo_salao: body.modulo_salao ?? false,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async atualizar(id: number, body: Partial<{
    name: string;
    address: string;
    logo_url: string;
    comissao_pct: number;
    business_hours: object;
    payment_config: object;
    user_id: string;
    modulo_delivery: boolean;
    modulo_salao: boolean;
  }>) {
    const { user_id, ...resto } = body;

    // Delega ao serviço central pra manter user_profiles.role sincronizado
    // com o vínculo — editar só restaurants.user_id aqui deixava o dono sem
    // acesso ao painel mesmo com o vínculo "correto" no banco.
    if ('user_id' in body) {
      await this.usuarios.sincronizarVinculoDono(id, user_id || null);
    }

    const payload: Record<string, any> = { ...resto, updated_at: new Date().toISOString() };

    const { data, error } = await this.supabase.client
      .from('restaurants')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Empresa ${id} não encontrada`);
    return data;
  }

  async bloquear(id: number, bloqueado: boolean) {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .update({ bloqueado, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, bloqueado')
      .single();
    if (error) throw error;
    return data;
  }

  async atenderSolicitacaoDominio(id: number) {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .update({
        custom_domain_status: null,
        custom_domain_motivo_recusa: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, name, custom_domain, custom_domain_status')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Empresa ${id} não encontrada`);
    return data;
  }

  async recusarSolicitacaoDominio(id: number, motivo: string) {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .update({
        custom_domain_status: 'recusado',
        custom_domain_motivo_recusa: motivo || 'Não especificado',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, name, custom_domain, custom_domain_status, custom_domain_motivo_recusa')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundException(`Empresa ${id} não encontrada`);
    return data;
  }

  async remover(id: number) {
    const { error } = await this.supabase.client
      .from('restaurants')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { mensagem: `Empresa ${id} removida` };
  }

  async getConfig(id: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('payment_config')
      .eq('id', id)
      .maybeSingle();

    const cfg = (data?.payment_config ?? {}) as Record<string, any>;

    return {
      pagbank_sandbox: cfg.pagbank_sandbox ?? true,
      pagbank_webhook_url: cfg.pagbank_webhook_url ?? '',
      pagbank_token_masked: cfg.pagbank_token
        ? `${'•'.repeat(8)}${String(cfg.pagbank_token).slice(-4)}`
        : null,
      configurado: !!cfg.pagbank_token,
    };
  }

  async updateConfig(
    id: number,
    body: { pagbank_token?: string; pagbank_sandbox?: boolean; pagbank_webhook_url?: string },
  ) {
    const { data: atual } = await this.supabase.client
      .from('restaurants')
      .select('payment_config')
      .eq('id', id)
      .maybeSingle();

    const cfg = (atual?.payment_config ?? {}) as Record<string, any>;
    const novo: Record<string, any> = { ...cfg };

    if (body.pagbank_token !== undefined && body.pagbank_token !== '') {
      novo.pagbank_token = body.pagbank_token;
    }
    if (body.pagbank_sandbox !== undefined) novo.pagbank_sandbox = body.pagbank_sandbox;
    if (body.pagbank_webhook_url !== undefined) novo.pagbank_webhook_url = body.pagbank_webhook_url;

    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ payment_config: novo, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
    return this.getConfig(id);
  }
}

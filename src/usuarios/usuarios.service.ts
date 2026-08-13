import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class UsuariosService {
  constructor(private supabase: SupabaseService) {}

  // Fonte única da regra "vínculo restaurants.user_id <-> user_profiles.role".
  // Idempotente: pode ser chamado com o mesmo novoUserId que já está no
  // restaurante (caso do /finalizar, que não troca dono, só garante a elevação).
  async sincronizarVinculoDono(restaurantId: number, novoUserId: string | null): Promise<void> {
    const { data: restaurant, error } = await this.supabase.client
      .from('restaurants')
      .select('user_id')
      .eq('id', restaurantId)
      .single();
    if (error) throw error;

    const donoAnteriorId: string | null = restaurant.user_id;

    if (donoAnteriorId !== novoUserId) {
      const { error: eUpd } = await this.supabase.client
        .from('restaurants')
        .update({ user_id: novoUserId, updated_at: new Date().toISOString() })
        .eq('id', restaurantId);
      if (eUpd) throw eUpd;
    }

    if (novoUserId) await this.elevarSeNecessario(novoUserId);
    if (donoAnteriorId && donoAnteriorId !== novoUserId) await this.rebaixarSeOrfao(donoAnteriorId);
  }

  private async elevarSeNecessario(userId: string): Promise<void> {
    const { data: perfil, error } = await this.supabase.client
      .from('user_profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!perfil || perfil.role === 'admin' || perfil.role === 'restaurant_owner') return;

    const { error: eUpd } = await this.supabase.client
      .from('user_profiles')
      .update({ role: 'restaurant_owner', updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (eUpd) throw eUpd;
  }

  private async rebaixarSeOrfao(userId: string): Promise<void> {
    const { data: perfil } = await this.supabase.client
      .from('user_profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (perfil?.role !== 'restaurant_owner') return;

    const { data: outraLoja } = await this.supabase.client
      .from('restaurants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (outraLoja) return;

    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'customer', updated_at: new Date().toISOString() })
      .eq('id', userId);
  }

  async listar(params: { busca?: string; role?: string; page: number; limit: number }) {
    let query = this.supabase.client
      .from('user_profiles')
      .select('id, name, email, role, must_change_password, created_at', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (params.role) query = query.eq('role', params.role);
    if (params.busca) query = query.or(`name.ilike.%${params.busca}%,email.ilike.%${params.busca}%`);

    const from = (params.page - 1) * params.limit;
    query = query.range(from, from + params.limit - 1);

    const { data: usuarios, error, count } = await query;
    if (error) throw error;

    const ids = (usuarios ?? []).map((u) => u.id);
    const { data: restaurantes } = ids.length
      ? await this.supabase.client.from('restaurants').select('id, name, slug, user_id').in('user_id', ids)
      : { data: [] as any[] };

    const porUserId = new Map((restaurantes ?? []).map((r) => [r.user_id, r]));
    return {
      usuarios: (usuarios ?? []).map((u) => ({ ...u, restaurante: porUserId.get(u.id) ?? null })),
      total: count ?? 0,
    };
  }

  async trocarCredenciais(
    adminUserId: string,
    targetUserId: string,
    body: { email?: string; senha?: string },
  ) {
    if (!body.email && !body.senha) throw new BadRequestException('Informe email e/ou senha.');
    if (body.senha && body.senha.length < 8) {
      throw new BadRequestException('Senha deve ter no mínimo 8 caracteres.');
    }

    const { data: perfilAntes } = await this.supabase.client
      .from('user_profiles')
      .select('email')
      .eq('id', targetUserId)
      .maybeSingle();
    if (!perfilAntes) throw new NotFoundException('Usuário não encontrado.');

    const payload: Record<string, any> = {};
    // email_confirm evita exigir confirmação por email — é o comportamento
    // certo pro fluxo de suporte manual (usuário travado, sem acesso ao
    // email antigo/novo), diferente da troca por autoatendimento.
    if (body.email) {
      payload.email = body.email;
      payload.email_confirm = true;
    }
    if (body.senha) payload.password = body.senha;

    const { error } = await this.supabase.client.auth.admin.updateUserById(targetUserId, payload);
    if (error) throw error;

    if (body.email) {
      await this.supabase.client
        .from('user_profiles')
        .update({ email: body.email, updated_at: new Date().toISOString() })
        .eq('id', targetUserId);
    }

    await this.supabase.client.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      target_user_id: targetUserId,
      acao: body.email && body.senha ? 'trocar_email_e_senha' : body.email ? 'trocar_email' : 'trocar_senha',
      // nunca logar a senha em texto/hash — só metadados
      detalhes: { email_anterior: perfilAntes.email, email_novo: body.email ?? null, senha_alterada: !!body.senha },
    });

    return { sucesso: true };
  }

  async listarAuditoria(targetUserId?: string) {
    let query = this.supabase.client
      .from('admin_audit_log')
      .select('id, admin_user_id, target_user_id, acao, detalhes, criado_em')
      .order('criado_em', { ascending: false })
      .limit(200);
    if (targetUserId) query = query.eq('target_user_id', targetUserId);

    const { data, error } = await query;
    if (error) throw error;
    return { logs: data ?? [] };
  }
}

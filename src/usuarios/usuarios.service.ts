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
      .select('id, name, email, role, phone_e164, bloqueado, must_change_password, created_at', { count: 'exact' })
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

  private static readonly ROLES_VALIDOS = ['admin', 'restaurant_owner', 'customer', 'motoboy'];

  async editar(
    adminUserId: string,
    targetUserId: string,
    body: { name?: string; role?: string; phone_e164?: string },
  ) {
    if (body.role && !UsuariosService.ROLES_VALIDOS.includes(body.role)) {
      throw new BadRequestException('Papel inválido.');
    }

    const { data: perfilAntes } = await this.supabase.client
      .from('user_profiles')
      .select('name, role, phone_e164')
      .eq('id', targetUserId)
      .maybeSingle();
    if (!perfilAntes) throw new NotFoundException('Usuário não encontrado.');

    if (body.role && body.role !== perfilAntes.role && targetUserId === adminUserId) {
      throw new BadRequestException('Você não pode alterar seu próprio papel.');
    }

    const payload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) payload.name = body.name.trim() || null;
    if (body.role !== undefined) payload.role = body.role;
    if (body.phone_e164 !== undefined) payload.phone_e164 = body.phone_e164.trim() || null;

    const { data, error } = await this.supabase.client
      .from('user_profiles')
      .update(payload)
      .eq('id', targetUserId)
      .select('id, name, email, role, phone_e164, bloqueado, must_change_password, created_at')
      .single();
    if (error) throw error;

    // Mantém user_metadata.role do JWT sincronizado — é o que os guards
    // (JwtGuard) leem pra decidir req.userRole sem consultar o banco.
    if (body.role && body.role !== perfilAntes.role) {
      await this.supabase.client.auth.admin.updateUserById(targetUserId, {
        user_metadata: { role: body.role },
      });
    }

    await this.supabase.client.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      target_user_id: targetUserId,
      acao: 'editar_usuario',
      detalhes: { antes: perfilAntes, depois: body },
    });

    return data;
  }

  async bloquear(adminUserId: string, targetUserId: string, bloqueado: boolean) {
    if (bloqueado && targetUserId === adminUserId) {
      throw new BadRequestException('Você não pode bloquear sua própria conta.');
    }

    const { data: perfilAntes } = await this.supabase.client
      .from('user_profiles')
      .select('email')
      .eq('id', targetUserId)
      .maybeSingle();
    if (!perfilAntes) throw new NotFoundException('Usuário não encontrado.');

    // ban_duration impede novos logins/refresh no Supabase Auth. Sessões já
    // emitidas (access token de curta duração) continuam válidas até expirar
    // ou tentar renovar — mesmo trade-off já aceito em outros pontos do app
    // (ver revogação de licença), não vale o custo de checar isso em toda
    // request autenticada.
    const { error: eBan } = await this.supabase.client.auth.admin.updateUserById(targetUserId, {
      ban_duration: bloqueado ? '876000h' : 'none',
    });
    if (eBan) throw eBan;

    const { data, error } = await this.supabase.client
      .from('user_profiles')
      .update({ bloqueado, updated_at: new Date().toISOString() })
      .eq('id', targetUserId)
      .select('id, name, email, role, bloqueado')
      .single();
    if (error) throw error;

    await this.supabase.client.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      target_user_id: targetUserId,
      acao: bloqueado ? 'bloquear_usuario' : 'desbloquear_usuario',
      detalhes: { email: perfilAntes.email },
    });

    return data;
  }

  async excluir(adminUserId: string, targetUserId: string) {
    if (targetUserId === adminUserId) {
      throw new BadRequestException('Você não pode excluir sua própria conta.');
    }

    const { data: perfilAntes } = await this.supabase.client
      .from('user_profiles')
      .select('email, role')
      .eq('id', targetUserId)
      .maybeSingle();
    if (!perfilAntes) throw new NotFoundException('Usuário não encontrado.');

    // Exclui em auth.users; user_profiles tem FK ON DELETE CASCADE (some
    // junto). Restaurantes vinculados não são apagados — restaurants.user_id
    // é ON DELETE SET NULL, então a loja fica sem dono, não é destruída.
    const { error } = await this.supabase.client.auth.admin.deleteUser(targetUserId);
    if (error) throw error;

    await this.supabase.client.from('admin_audit_log').insert({
      admin_user_id: adminUserId,
      target_user_id: null,
      acao: 'excluir_usuario',
      detalhes: { usuario_excluido_id: targetUserId, email: perfilAntes.email, role: perfilAntes.role },
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

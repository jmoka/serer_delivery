import { Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const normalizarCnpj = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

@Injectable()
export class GdoorService {
  constructor(private supabase: SupabaseService) {}

  // ── Lado dono (RestaurantOwnerGuard) ──────────────────────────────

  async gerarToken(restaurantId: number) {
    const token = crypto.randomUUID();
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_agente_token: token })
      .eq('id', restaurantId);
    if (error) throw error;
    return { token };
  }

  async statusAgente(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('gdoor_agente_token, gdoor_agente_ultimo_ping, gdoor_cnpj_esperado, gdoor_cnpj_confirmado')
      .eq('id', restaurantId)
      .maybeSingle();

    const ultimoPing = data?.gdoor_agente_ultimo_ping ? new Date(data.gdoor_agente_ultimo_ping) : null;
    const online = !!ultimoPing && Date.now() - ultimoPing.getTime() < 60_000;
    const cnpjEsperado = data?.gdoor_cnpj_esperado ?? null;
    const cnpjConfirmado = data?.gdoor_cnpj_confirmado ?? null;
    // Sem CNPJ esperado cadastrado ainda = não dá pra afirmar que confere nem que não confere.
    const cnpjConfere = cnpjEsperado && cnpjConfirmado
      ? normalizarCnpj(cnpjEsperado) === normalizarCnpj(cnpjConfirmado)
      : null;

    return {
      pareado: !!data?.gdoor_agente_token,
      online,
      ultimo_ping: data?.gdoor_agente_ultimo_ping ?? null,
      cnpj_esperado: cnpjEsperado,
      cnpj_confirmado: cnpjConfirmado,
      cnpj_confere: cnpjConfere,
    };
  }

  async salvarCnpjEsperado(restaurantId: number, cnpj: string) {
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_cnpj_esperado: cnpj?.trim() || null })
      .eq('id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // ── Lado agente (AgenteGdoorGuard) ────────────────────────────────

  // Chamado pelo agente Python a cada poll — mantém gdoor_cnpj_confirmado sempre
  // atualizado com o que o Firebird local reportou de verdade, pra comparação.
  async registrarCnpjAgente(restaurantId: number, cnpj: string) {
    if (!cnpj?.trim()) return { ok: true };
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ gdoor_cnpj_confirmado: cnpj.trim() })
      .eq('id', restaurantId);
    if (error) throw error;
    return { ok: true };
  }

  // INSERT puro — nunca faz chamada HTTP. O agente é quem puxa (polling), nunca
  // o contrário (server_delivery roda na nuvem, não alcança a máquina do restaurante).
  async criarJob(restaurantId: number, pedidoId: number, payload: Record<string, any>) {
    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .insert({ restaurant_id: restaurantId, pedido_id: pedidoId, payload });
    if (error) throw error;
    return { ok: true };
  }

  // Só devolve trabalho se o CNPJ confirmado bater com o esperado — trava de
  // segurança extra além do token: mesmo com o token certo, um GDOOR de outro
  // CNPJ (instalação errada) não recebe pré-vendas.
  async jobsPendentes(restaurantId: number, cnpjEsperado: string | null, cnpjConfirmado: string | null) {
    const cnpjConfere = !cnpjEsperado || (cnpjConfirmado && normalizarCnpj(cnpjEsperado) === normalizarCnpj(cnpjConfirmado));
    if (!cnpjConfere) return { jobs: [], bloqueado: true };

    const { data, error } = await this.supabase.client
      .from('gdoor_jobs')
      .select('id, pedido_id, payload')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .order('criado_em', { ascending: true });
    if (error) throw error;
    return { jobs: data ?? [], bloqueado: false };
  }

  private async garantirJobDoRestaurante(jobId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('gdoor_jobs')
      .select('id')
      .eq('id', jobId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Trabalho não encontrado');
  }

  async marcarProcessado(jobId: number, restaurantId: number, vendaIdGdoor: string) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .update({ status: 'processado', venda_id_gdoor: vendaIdGdoor, processado_em: new Date().toISOString() })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }

  async marcarErro(jobId: number, restaurantId: number, mensagem: string) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('gdoor_jobs')
      .update({ status: 'erro', erro_msg: mensagem ?? 'Erro desconhecido' })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }
}

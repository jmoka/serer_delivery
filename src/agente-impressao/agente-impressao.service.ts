import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AgenteImpressaoService {
  constructor(private supabase: SupabaseService) {}

  async gerarToken(restaurantId: number) {
    const token = crypto.randomUUID();
    const { error } = await this.supabase.client
      .from('restaurants')
      .update({ agente_impressao_token: token })
      .eq('id', restaurantId);
    if (error) throw error;
    return { token };
  }

  async statusAgente(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('agente_impressao_token, agente_impressao_ultimo_ping')
      .eq('id', restaurantId)
      .maybeSingle();

    const ultimoPing = data?.agente_impressao_ultimo_ping ? new Date(data.agente_impressao_ultimo_ping) : null;
    const online = !!ultimoPing && Date.now() - ultimoPing.getTime() < 60_000;

    return { pareado: !!data?.agente_impressao_token, online, ultimo_ping: data?.agente_impressao_ultimo_ping ?? null };
  }

  async impressorasDetectadas(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('impressoras_detectadas')
      .select('id, nome_sistema, detectado_em')
      .eq('restaurant_id', restaurantId)
      .order('nome_sistema', { ascending: true });
    if (error) throw error;
    return data;
  }

  // Chamado pelo agente Python — reporta as impressoras que enxerga no sistema.
  async reportarImpressoras(restaurantId: number, nomes: string[]) {
    if (!nomes?.length) return { ok: true };

    const { error } = await this.supabase.client
      .from('impressoras_detectadas')
      .upsert(
        nomes.map((nome_sistema) => ({ restaurant_id: restaurantId, nome_sistema, detectado_em: new Date().toISOString() })),
        { onConflict: 'restaurant_id,nome_sistema' },
      );
    if (error) throw error;
    return { ok: true };
  }

  // Chamado pelo agente Python — busca trabalhos pendentes das impressoras já mapeadas (nome_sistema preenchido).
  async jobsPendentes(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('impressao_jobs')
      .select('id, conteudo, impressoras(nome_sistema)')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .order('criado_em', { ascending: true });
    if (error) throw error;

    return (data ?? [])
      .filter((j: any) => j.impressoras?.nome_sistema)
      .map((j: any) => ({ id: j.id, conteudo: j.conteudo, nome_sistema: j.impressoras.nome_sistema }));
  }

  // Dono clica "Testar impressão" numa impressora cadastrada — só funciona se ela
  // já tiver um agente pareado (nome_sistema preenchido), senão não tem quem imprima.
  async criarJobTeste(restaurantId: number, impressoraId: number) {
    const { data: impressora } = await this.supabase.client
      .from('impressoras')
      .select('id, nome, setor, nome_sistema')
      .eq('id', impressoraId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!impressora) throw new NotFoundException('Impressora não encontrada');
    if (!impressora.nome_sistema) {
      throw new BadRequestException('Essa impressora ainda não está vinculada a um agente — vincule uma impressora detectada primeiro.');
    }

    const conteudo = [
      'TESTE DE IMPRESSÃO',
      impressora.nome,
      `Setor: ${impressora.setor}`,
      new Date().toLocaleString('pt-BR'),
      '--------------------------------',
      'Se você está lendo isso,',
      'a impressora está funcionando!',
      '--------------------------------',
    ].join('\n');

    const { error } = await this.supabase.client.from('impressao_jobs').insert({
      restaurant_id: restaurantId,
      impressora_id: impressoraId,
      conteudo,
    });
    if (error) throw error;
    return { ok: true };
  }

  private async garantirJobDoRestaurante(jobId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('impressao_jobs')
      .select('id')
      .eq('id', jobId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Trabalho de impressão não encontrado');
  }

  async marcarConcluido(jobId: number, restaurantId: number) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('impressao_jobs')
      .update({ status: 'impresso', impresso_em: new Date().toISOString() })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }

  async marcarErro(jobId: number, restaurantId: number, mensagem: string) {
    await this.garantirJobDoRestaurante(jobId, restaurantId);
    const { error } = await this.supabase.client
      .from('impressao_jobs')
      .update({ status: 'erro', erro_msg: mensagem ?? 'Erro desconhecido' })
      .eq('id', jobId);
    if (error) throw error;
    return { ok: true };
  }
}

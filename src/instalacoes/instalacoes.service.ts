import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PlanosService } from '../planos/planos.service';
import { CriarInstalacaoDto } from './dto/criar-instalacao.dto';
import { AtualizarInstalacaoDto } from './dto/atualizar-instalacao.dto';

const gerarSerial = () => {
  const bloco = () => randomBytes(2).toString('hex').toUpperCase();
  return `DHUB-${bloco()}-${bloco()}-${bloco()}`;
};

const SELECT_COM_ASSINATURA = '*, assinaturas(id, status, plano_id, trial_fim, planos(nome, valor, periodicidade))';

@Injectable()
export class InstalacoesService {
  constructor(
    private supabase: SupabaseService,
    private planos: PlanosService,
  ) {}

  async listar() {
    const { data, error } = await this.supabase.client
      .from('instalacoes_locais')
      .select(SELECT_COM_ASSINATURA)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { instalacoes: data ?? [] };
  }

  async buscar(id: number) {
    const { data, error } = await this.supabase.client
      .from('instalacoes_locais')
      .select(SELECT_COM_ASSINATURA)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Instalação não encontrada');
    return data;
  }

  async detalheComFaturas(id: number) {
    const instalacao = await this.buscar(id);
    const { faturas } = await this.planos.buscarAssinaturaPorInstalacao(id).catch(() => ({ faturas: [] }));
    return { instalacao, faturas };
  }

  async criar(body: CriarInstalacaoDto) {
    // Colisão de serial é praticamente impossível (6 bytes aleatórios), mas
    // tenta de novo em caso de raro conflito em vez de falhar pro admin.
    let novo: any = null;
    for (let tentativa = 0; tentativa < 5 && !novo; tentativa++) {
      const { data, error } = await this.supabase.client
        .from('instalacoes_locais')
        .insert({
          nome_cliente: body.nome_cliente,
          contato: body.contato ?? null,
          dominio_ou_ip: body.dominio_ou_ip ?? null,
          serial: gerarSerial(),
        })
        .select()
        .single();
      if (error) {
        if (String(error.message).includes('duplicate')) continue;
        throw error;
      }
      novo = data;
    }
    if (!novo) throw new BadRequestException('Falha ao gerar serial único, tente novamente');

    if (body.plano_id) {
      await this.planos.atribuirAssinatura({ instalacaoId: novo.id }, body.plano_id);
    }

    return novo;
  }

  async atualizar(id: number, body: AtualizarInstalacaoDto) {
    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.nome_cliente !== undefined) campos.nome_cliente = body.nome_cliente;
    if (body.contato !== undefined) campos.contato = body.contato;
    if (body.dominio_ou_ip !== undefined) campos.dominio_ou_ip = body.dominio_ou_ip;
    if (body.ativo !== undefined) campos.ativo = body.ativo;

    const { data, error } = await this.supabase.client
      .from('instalacoes_locais')
      .update(campos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Instalação não encontrada');
    return data;
  }

  async atribuirPlano(id: number, planoId: number) {
    await this.buscar(id); // garante que existe antes de tocar em assinatura
    return this.planos.atribuirAssinatura({ instalacaoId: id }, planoId);
  }

  async gerarFaturaManual(id: number) {
    return this.planos.gerarFaturaManualInstalacao(id);
  }

  // Chamado periodicamente pela própria instalação local (checkin) — identifica
  // pelo serial (não tem sessão/JWT, o serial é a credencial).
  //
  // Serial revogado responde 200 com bloqueado:true (não erro) — assim o
  // cliente local distingue "revogado de propósito" (bloqueia na hora) de
  // "central fora do ar/sem internet" (mantém último status, só o erro de
  // fetch cai nesse segundo caso). Só serial que nunca existiu é erro de verdade.
  async checkin(serial: string) {
    const { data: instalacao, error } = await this.supabase.client
      .from('instalacoes_locais')
      .select('id, ativo')
      .eq('serial', serial)
      .maybeSingle();
    if (error) throw error;
    if (!instalacao) throw new NotFoundException('Serial inválido');

    if (!instalacao.ativo) {
      return {
        bloqueado: true,
        dias_atraso: 0,
        fatura_pendente_id: null,
        plano_nome: null,
        proxima_cobranca: null,
        revogado: true,
      };
    }

    await this.supabase.client
      .from('instalacoes_locais')
      .update({ ultimo_check_em: new Date().toISOString() })
      .eq('id', instalacao.id);

    return this.planos.sincronizarPeriodo({ instalacaoId: instalacao.id });
  }
}

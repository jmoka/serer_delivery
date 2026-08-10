import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PagBankClient } from '../pagamentos/pagbank.client';
import { CriarPlanoDto } from './dto/criar-plano.dto';
import { AtualizarPlanoDto } from './dto/atualizar-plano.dto';

const STATUS_PAGOS = ['PAID', 'COMPLETED', 'AVAILABLE'];

// Titular de uma assinatura: loja do SaaS multi-tenant OU instalação local licenciada.
// Exatamente um dos dois — nunca os dois, nunca nenhum (mesma regra do CHECK no banco).
export type Titular = { restaurantId: number } | { instalacaoId: number };

const MESES_POR_PERIODICIDADE: Record<string, number> = {
  mensal: 1,
  trimestral: 3,
  anual: 12,
};

const somarMeses = (data: Date, meses: number) => {
  const d = new Date(data);
  d.setMonth(d.getMonth() + meses);
  return d;
};

const somarDias = (data: Date, dias: number) => {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d;
};

@Injectable()
export class PlanosService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  // ── CRUD de planos ──────────────────────────────────────────────

  async listarPlanos() {
    const { data, error } = await this.supabase.client
      .from('planos')
      .select('*')
      .order('valor', { ascending: true });
    if (error) throw error;
    return { planos: data ?? [] };
  }

  // Planos que o dono pode escolher na tela de upgrade — só os ativos do tipo certo
  async listarPlanosAtivos(tipo: 'saas' | 'local' = 'saas') {
    const { data, error } = await this.supabase.client
      .from('planos')
      .select('*')
      .eq('ativo', true)
      .eq('tipo', tipo)
      .order('valor', { ascending: true });
    if (error) throw error;
    return { planos: data ?? [] };
  }

  async buscarPlano(id: number) {
    const { data, error } = await this.supabase.client
      .from('planos')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Plano não encontrado');
    return data;
  }

  private async garantirNomePlanoUnico(nome: string, ignorarId?: number) {
    let query = this.supabase.client.from('planos').select('id').ilike('nome', nome.trim());
    if (ignorarId) query = query.neq('id', ignorarId);
    const { data, error } = await query;
    if (error) throw error;
    if (data && data.length > 0) {
      throw new ConflictException(`Já existe um plano chamado "${nome.trim()}"`);
    }
  }

  async criarPlano(body: CriarPlanoDto) {
    await this.garantirNomePlanoUnico(body.nome);

    const { data, error } = await this.supabase.client
      .from('planos')
      .insert({
        nome: body.nome,
        valor: body.valor,
        periodicidade: body.periodicidade,
        tipo: body.tipo ?? 'saas',
        limite_produtos: body.limite_produtos ?? null,
        piso_faturamento: body.piso_faturamento ?? null,
        trial_dias: body.trial_dias ?? 0,
        ativo: body.ativo ?? true,
        inclui_delivery: body.inclui_delivery ?? true,
        inclui_salao: body.inclui_salao ?? false,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async atualizarPlano(id: number, body: AtualizarPlanoDto) {
    if (body.nome !== undefined) await this.garantirNomePlanoUnico(body.nome, id);

    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.nome !== undefined) campos.nome = body.nome;
    if (body.valor !== undefined) campos.valor = body.valor;
    if (body.periodicidade !== undefined) campos.periodicidade = body.periodicidade;
    if (body.tipo !== undefined) campos.tipo = body.tipo;
    if (body.limite_produtos !== undefined) campos.limite_produtos = body.limite_produtos;
    if (body.piso_faturamento !== undefined) campos.piso_faturamento = body.piso_faturamento;
    if (body.trial_dias !== undefined) campos.trial_dias = body.trial_dias;
    if (body.ativo !== undefined) campos.ativo = body.ativo;
    if (body.inclui_delivery !== undefined) campos.inclui_delivery = body.inclui_delivery;
    if (body.inclui_salao !== undefined) campos.inclui_salao = body.inclui_salao;

    const { data, error } = await this.supabase.client
      .from('planos')
      .update(campos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Plano não encontrado');
    return data;
  }

  async removerPlano(id: number) {
    const { count, error: countErro } = await this.supabase.client
      .from('assinaturas')
      .select('id', { count: 'exact', head: true })
      .eq('plano_id', id);
    if (countErro) throw countErro;
    if ((count ?? 0) > 0) {
      throw new ConflictException(
        'Este plano tem lojas vinculadas — desative com "ativo: false" em vez de remover',
      );
    }

    const { error } = await this.supabase.client.from('planos').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Assinaturas (loja <-> plano) ────────────────────────────────

  async listarAssinaturas() {
    const { data, error } = await this.supabase.client
      .from('assinaturas')
      .select('*, restaurants(name), planos(nome, valor, periodicidade)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { assinaturas: data ?? [] };
  }

  private async buscarAssinaturaRaw(titular: Titular) {
    let q = this.supabase.client.from('assinaturas').select('*, planos(*)');
    q = 'restaurantId' in titular ? q.eq('restaurant_id', titular.restaurantId) : q.eq('instalacao_id', titular.instalacaoId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return data;
  }

  async buscarAssinaturaPorRestaurante(restaurantId: number) {
    const assinatura = await this.buscarAssinaturaRaw({ restaurantId });
    if (!assinatura) throw new NotFoundException('Loja não tem assinatura');

    const { data: faturas, error } = await this.supabase.client
      .from('plano_faturas')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('periodo_inicio', { ascending: false });
    if (error) throw error;

    return { assinatura, faturas: faturas ?? [] };
  }

  async buscarAssinaturaPorInstalacao(instalacaoId: number) {
    const assinatura = await this.buscarAssinaturaRaw({ instalacaoId });
    if (!assinatura) throw new NotFoundException('Instalação não tem assinatura');

    const { data: faturas, error } = await this.supabase.client
      .from('plano_faturas')
      .select('*')
      .eq('instalacao_id', instalacaoId)
      .order('periodo_inicio', { ascending: false });
    if (error) throw error;

    return { assinatura, faturas: faturas ?? [] };
  }

  async atribuirAssinatura(titular: Titular, planoId: number) {
    const plano = await this.buscarPlano(planoId);

    if ('restaurantId' in titular) {
      const { data: restaurante, error: restErro } = await this.supabase.client
        .from('restaurants').select('id').eq('id', titular.restaurantId).maybeSingle();
      if (restErro) throw restErro;
      if (!restaurante) throw new NotFoundException('Loja não encontrada');

      // Módulos liberados na loja passam a refletir o que o plano inclui
      const { error: moduloErro } = await this.supabase.client
        .from('restaurants')
        .update({
          modulo_delivery: plano.inclui_delivery,
          modulo_salao: plano.inclui_salao,
          updated_at: new Date().toISOString(),
        })
        .eq('id', titular.restaurantId);
      if (moduloErro) throw moduloErro;
    } else {
      const { data: instalacao, error: instErro } = await this.supabase.client
        .from('instalacoes_locais').select('id').eq('id', titular.instalacaoId).maybeSingle();
      if (instErro) throw instErro;
      if (!instalacao) throw new NotFoundException('Instalação não encontrada');
    }

    const existente = await this.buscarAssinaturaRaw(titular);
    const agora = new Date();
    const temTrial = (plano.trial_dias ?? 0) > 0;
    const trialFim = temTrial ? somarDias(agora, plano.trial_dias) : null;

    if (existente) {
      // Troca de plano reinicia o ciclo de cobrança: recalcula trial/status a
      // partir do plano novo (senão um plano com trial_dias=0 continuaria preso
      // no status "trial" herdado do plano anterior).
      const { data, error } = await this.supabase.client
        .from('assinaturas')
        .update({
          plano_id: planoId,
          status: temTrial ? 'trial' : 'ativa',
          trial_fim: trialFim?.toISOString() ?? null,
          ultimo_periodo_faturado_fim: (trialFim ?? agora).toISOString(),
          updated_at: agora.toISOString(),
        })
        .eq('id', existente.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const novaAssinatura: Record<string, any> = {
      plano_id: planoId,
      status: temTrial ? 'trial' : 'ativa',
      data_inicio: agora.toISOString(),
      trial_fim: trialFim?.toISOString() ?? null,
      ultimo_periodo_faturado_fim: (trialFim ?? agora).toISOString(),
    };
    if ('restaurantId' in titular) novaAssinatura.restaurant_id = titular.restaurantId;
    else novaAssinatura.instalacao_id = titular.instalacaoId;

    const { data, error } = await this.supabase.client
      .from('assinaturas')
      .insert(novaAssinatura)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async cancelarAssinatura(titular: Titular) {
    const existente = await this.buscarAssinaturaRaw(titular);
    if (!existente) throw new NotFoundException('Assinatura não encontrada');

    const { data, error } = await this.supabase.client
      .from('assinaturas')
      .update({ status: 'cancelada', data_cancelamento: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', existente.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ── Limite de produtos ──────────────────────────────────────────

  async verificarLimiteProdutos(restaurantId: number) {
    const assinatura = await this.buscarAssinaturaRaw({ restaurantId });
    if (!assinatura || assinatura.status === 'cancelada') return; // loja sem plano = sem limite
    const limite = assinatura.planos?.limite_produtos;
    if (limite == null) return; // ilimitado

    const { count, error } = await this.supabase.client
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true);
    if (error) throw error;

    if ((count ?? 0) >= limite) {
      throw new ForbiddenException(
        `Limite de ${limite} produtos do plano "${assinatura.planos.nome}" atingido. Faça upgrade de plano para cadastrar mais produtos.`,
      );
    }
  }

  // ── Faturamento / geração lazy de fatura ────────────────────────

  private async diasTolerancia() {
    const { data } = await this.supabase.client
      .from('platform_settings').select('config').eq('id', 1).maybeSingle();
    const cfg = (data?.config ?? {}) as Record<string, any>;
    return cfg.plano_dias_tolerancia ?? 3;
  }

  // Marca pendente->vencida, gera faturas de todo período fechado ainda não
  // faturado, e devolve o status atual de bloqueio da loja.
  // forcar=true também gera fatura do período atual mesmo que ainda não tenha
  // fechado (usado pelo botão "Renovar agora"/"Gerar fatura" sob demanda).
  async sincronizarPeriodo(titular: Titular, forcar = false) {
    const assinatura = await this.buscarAssinaturaRaw(titular);
    if (!assinatura || assinatura.status === 'cancelada') {
      return { bloqueado: false, dias_atraso: 0, fatura_pendente_id: null, plano_nome: null, proxima_cobranca: null };
    }

    const agora = new Date();
    const plano = assinatura.planos;
    const meses = MESES_POR_PERIODICIDADE[plano.periodicidade] ?? 1;

    // Marca vencidas
    await this.supabase.client
      .from('plano_faturas')
      .update({ status: 'vencida', atualizado_em: agora.toISOString() })
      .eq('assinatura_id', assinatura.id)
      .eq('status', 'pendente')
      .lt('vencimento', agora.toISOString());

    // Gera períodos fechados pendentes de fatura (+ o período atual se forcar=true)
    let inicioPeriodo = assinatura.ultimo_periodo_faturado_fim
      ? new Date(assinatura.ultimo_periodo_faturado_fim)
      : new Date(assinatura.data_inicio);
    let ultimoFimFaturado = assinatura.ultimo_periodo_faturado_fim
      ? new Date(assinatura.ultimo_periodo_faturado_fim)
      : null;

    // Se já existe fatura pendente/vencida/isenta de QUALQUER período, "Renovar
    // agora" não pode gerar outra. Isenta entra aqui também — senão clicar de
    // novo (a fatura isenta não bloqueia "pendente/vencida") empurra a cobrança
    // pro período seguinte a cada clique, gerando várias faturas de R$0 em
    // sequência.
    let temPendenteAberta = false;
    if (forcar) {
      const { data: pendenteExistente, error: pendErroCheck } = await this.supabase.client
        .from('plano_faturas')
        .select('id')
        .eq('assinatura_id', assinatura.id)
        .in('status', ['pendente', 'vencida', 'isenta'])
        .is('plano_id_troca', null)
        .limit(1)
        .maybeSingle();
      if (pendErroCheck) throw pendErroCheck;
      temPendenteAberta = !!pendenteExistente;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const fimPeriodo = somarMeses(inicioPeriodo, meses);
      const periodoFechado = fimPeriodo < agora;
      if (!periodoFechado && !forcar) break;

      if (!periodoFechado) {
        if (temPendenteAberta) break;

        // Período em aberto forçado: se já existe fatura pra esse período (de um
        // "Renovar agora" anterior), não gera outra nem avança o ciclo de novo —
        // senão cada clique empurraria a cobrança um mês pra frente.
        const { data: jaExiste, error: existeErro } = await this.supabase.client
          .from('plano_faturas')
          .select('id')
          .eq('assinatura_id', assinatura.id)
          .eq('periodo_inicio', inicioPeriodo.toISOString())
          .maybeSingle();
        if (existeErro) throw existeErro;
        if (jaExiste) break;
      }

      // Isenção por piso de faturamento só existe pro SaaS — instalação local
      // não tem pedidos na tabela `orders` central (banco próprio, separado),
      // então sempre cobra o valor cheio do plano.
      let isento = false;
      let valorFatura = plano.valor;
      if ('restaurantId' in titular) {
        const { data: faturamentoRows, error: fatErro } = await this.supabase.client
          .from('orders')
          .select('total')
          .eq('restaurant_id', titular.restaurantId)
          .eq('status', 'delivered')
          .gte('created_at', inicioPeriodo.toISOString())
          .lt('created_at', fimPeriodo.toISOString());
        if (fatErro) throw fatErro;

        const faturamento = (faturamentoRows ?? []).reduce((acc, o: any) => acc + (o.total ?? 0), 0);
        isento = plano.piso_faturamento != null && faturamento < plano.piso_faturamento;
        valorFatura = isento ? 0 : plano.valor;
      }

      const vencimento = somarDias(fimPeriodo, 5);

      const novaFatura: Record<string, any> = {
        assinatura_id: assinatura.id,
        periodo_inicio: inicioPeriodo.toISOString(),
        periodo_fim: fimPeriodo.toISOString(),
        valor: valorFatura,
        status: isento ? 'isenta' : 'pendente',
        vencimento: vencimento.toISOString(),
      };
      if ('restaurantId' in titular) novaFatura.restaurant_id = titular.restaurantId;
      else novaFatura.instalacao_id = titular.instalacaoId;

      const { error: insErro } = await this.supabase.client
        .from('plano_faturas')
        .insert(novaFatura);
      // Ignora conflito de unicidade (fatura já gerada em corrida concorrente)
      if (insErro && !String(insErro.message).includes('duplicate')) throw insErro;

      ultimoFimFaturado = fimPeriodo;
      inicioPeriodo = fimPeriodo;

      if (!periodoFechado) break; // gerou o período em aberto sob demanda — não continua pro futuro
    }

    if (ultimoFimFaturado && ultimoFimFaturado.getTime() !== new Date(assinatura.ultimo_periodo_faturado_fim ?? 0).getTime()) {
      await this.supabase.client
        .from('assinaturas')
        .update({ ultimo_periodo_faturado_fim: ultimoFimFaturado.toISOString(), updated_at: agora.toISOString() })
        .eq('id', assinatura.id);
    }

    // Recalcula bloqueio com base no estado atual das faturas
    const tolerancia = await this.diasTolerancia();
    const { data: pendentes, error: pendErro } = await this.supabase.client
      .from('plano_faturas')
      .select('id, vencimento, status')
      .eq('assinatura_id', assinatura.id)
      .in('status', ['pendente', 'vencida'])
      .is('plano_id_troca', null)
      .order('vencimento', { ascending: true });
    if (pendErro) throw pendErro;

    let bloqueado = false;
    let diasAtraso = 0;
    let faturaPendenteId: number | null = null;
    if ((pendentes ?? []).length > 0) {
      faturaPendenteId = pendentes[0].id;
      const vencimento = new Date(pendentes[0].vencimento);
      diasAtraso = Math.max(0, Math.floor((agora.getTime() - vencimento.getTime()) / 86400000));
      bloqueado = diasAtraso > tolerancia;
    }

    const proximaCobranca = somarMeses(ultimoFimFaturado ?? inicioPeriodo, meses);

    return {
      bloqueado,
      dias_atraso: diasAtraso,
      fatura_pendente_id: faturaPendenteId,
      plano_nome: plano.nome,
      proxima_cobranca: proximaCobranca.toISOString(),
    };
  }

  async detalhePlanoRestaurante(restaurantId: number) {
    const status = await this.sincronizarPeriodo({ restaurantId });
    const { assinatura, faturas } = await this.buscarAssinaturaPorRestaurante(restaurantId);

    const { count: produtosAtivos, error } = await this.supabase.client
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true);
    if (error) throw error;

    return {
      ...status,
      assinatura,
      faturas,
      produtos_ativos: produtosAtivos ?? 0,
      limite_produtos: assinatura.planos?.limite_produtos ?? null,
    };
  }

  async gerarFaturaManual(restaurantId: number) {
    await this.sincronizarPeriodo({ restaurantId }, true);
    return this.buscarAssinaturaPorRestaurante(restaurantId);
  }

  // Dono renovando/antecipando a cobrança da própria loja pelo painel do plano
  async renovarAgora(restaurantId: number) {
    return this.sincronizarPeriodo({ restaurantId }, true);
  }

  // Dono pedindo upgrade/downgrade — não troca na hora, gera uma fatura do
  // valor cheio do plano novo. A troca só é aplicada quando essa fatura é
  // confirmada paga (ver aplicarTrocaSeNecessario).
  async iniciarTrocaPlano(restaurantId: number, planoId: number) {
    const assinatura = await this.buscarAssinaturaRaw({ restaurantId });
    if (!assinatura) throw new NotFoundException('Loja não tem assinatura');

    const plano = await this.buscarPlano(planoId);
    if (plano.tipo !== 'saas') throw new BadRequestException('Plano inválido');
    if (plano.id === assinatura.plano_id) throw new BadRequestException('Já está nesse plano');

    const agora = new Date();
    const { data, error } = await this.supabase.client
      .from('plano_faturas')
      .insert({
        assinatura_id: assinatura.id,
        restaurant_id: restaurantId,
        plano_id_troca: planoId,
        periodo_inicio: agora.toISOString(),
        periodo_fim: agora.toISOString(),
        valor: plano.valor,
        status: 'pendente',
        vencimento: agora.toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Chamado depois que uma fatura é confirmada paga (Pix webhook ou cartão na
  // hora) — se ela tinha plano_id_troca marcado, aplica a troca de plano agora.
  private async aplicarTrocaSeNecessario(fatura: any) {
    if (!fatura.plano_id_troca || !fatura.restaurant_id) return;
    await this.atribuirAssinatura({ restaurantId: fatura.restaurant_id }, fatura.plano_id_troca);
  }

  async gerarFaturaManualInstalacao(instalacaoId: number) {
    await this.sincronizarPeriodo({ instalacaoId }, true);
    return this.buscarAssinaturaPorInstalacao(instalacaoId);
  }

  // ── Faturas (visão admin) ───────────────────────────────────────

  async listarFaturas(filtros: { restaurant_id?: number; status?: string; tipo?: 'saas' | 'local' }) {
    let q = this.supabase.client
      .from('plano_faturas')
      .select('*, restaurants(name), instalacoes_locais(nome_cliente, serial)')
      .order('vencimento', { ascending: false });
    if (filtros.restaurant_id) q = q.eq('restaurant_id', filtros.restaurant_id);
    if (filtros.status) q = q.eq('status', filtros.status);
    if (filtros.tipo === 'saas') q = q.not('restaurant_id', 'is', null);
    if (filtros.tipo === 'local') q = q.not('instalacao_id', 'is', null);
    const { data, error } = await q;
    if (error) throw error;
    return { faturas: data ?? [] };
  }

  async buscarFatura(id: number) {
    const { data, error } = await this.supabase.client
      .from('plano_faturas').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Fatura não encontrada');
    return data;
  }

  async buscarFaturaDoRestaurante(restaurantId: number, id: number) {
    const fatura = await this.buscarFatura(id);
    if (fatura.restaurant_id !== restaurantId) throw new NotFoundException('Fatura não encontrada');
    return fatura;
  }

  async marcarFaturaPaga(id: number) {
    const { data, error } = await this.supabase.client
      .from('plano_faturas')
      .update({ status: 'paga', pago_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Fatura não encontrada');
    return data;
  }

  // ── Pagamento via PagBank (cobrança direta loja -> plataforma, sem split) ──

  private async clientPlataforma() {
    const { data: platData } = await this.supabase.client
      .from('platform_settings').select('config').eq('id', 1).maybeSingle();
    const platCfg = (platData?.config ?? {}) as Record<string, any>;

    const token = platCfg.pagbank_platform_token || this.config.get<string>('PAGBANK_PLATFORM_TOKEN') || '';
    if (!token) throw new BadRequestException('PagBank da plataforma não configurado — fale com o suporte');
    const sandbox = platCfg.pagbank_sandbox ?? (this.config.get('PAGBANK_SANDBOX') !== 'false');

    const baseWebhook =
      platCfg.pagbank_webhook_url ||
      this.config.get<string>('PAGBANK_WEBHOOK_URL') ||
      'http://localhost:3002/pagamentos/webhook';
    const webhookUrl = baseWebhook.replace('/pagamentos/webhook', '/planos/webhook');

    return { client: new PagBankClient(token, sandbox), webhookUrl };
  }

  // Chave pública pro PagBank.js criptografar o cartão no navegador do dono
  async buscarChavePublicaCartao() {
    const { client } = await this.clientPlataforma();
    try {
      const resposta = await client.buscarChavePublica();
      return { public_key: resposta.public_key };
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao obter chave pública do PagBank');
    }
  }

  async pagarFatura(
    restaurantId: number,
    faturaId: number,
    body: { nome: string; email: string; cpf_cnpj: string; metodo?: 'pix' | 'credit_card' | 'debit_card'; card_encrypted?: string; parcelas?: number },
  ) {
    const fatura = await this.buscarFaturaDoRestaurante(restaurantId, faturaId);
    if (fatura.status === 'paga') throw new BadRequestException('Fatura já está paga');
    if (fatura.status === 'isenta' || fatura.status === 'cancelada') {
      throw new BadRequestException('Esta fatura não pode ser paga');
    }

    const metodo = body.metodo ?? 'pix';
    if (metodo === 'credit_card' || metodo === 'debit_card') {
      return this.pagarFaturaCartao(fatura, body, metodo);
    }

    // Reaproveita o QR já gerado pra essa fatura em vez de abrir ordem nova a cada clique
    if (fatura.pix_code && fatura.pagbank_order_id) {
      return { pix_code: fatura.pix_code, pix_qr_url: fatura.pix_qr_url, fatura_id: fatura.id };
    }

    const { client, webhookUrl } = await this.clientPlataforma();

    const valorCentavos = Math.round(fatura.valor * 100);
    const refId = `PLANO_${fatura.id}_${Date.now()}`;

    let resposta: any;
    try {
      resposta = await client.criarOrdemPix({
        reference_id: refId,
        valor_centavos: valorCentavos,
        customer: {
          name: body.nome,
          email: body.email,
          tax_id: body.cpf_cnpj.replace(/\D/g, ''),
        },
        itens: [{ name: `Assinatura — fatura #${fatura.id}`, quantity: 1, unit_amount: valorCentavos }],
        webhook_url: webhookUrl,
      });
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao gerar cobrança no PagBank');
    }

    const qrCode = resposta?.qr_codes?.[0];
    const pixCode = qrCode?.text ?? null;
    const pixQrUrl = qrCode?.links?.find((l: any) => l.media === 'image/png')?.href ?? null;

    const { error } = await this.supabase.client
      .from('plano_faturas')
      .update({
        pagbank_order_id: resposta.id,
        reference_id: refId,
        pix_code: pixCode,
        pix_qr_url: pixQrUrl,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', fatura.id);
    if (error) throw error;

    return { pix_code: pixCode, pix_qr_url: pixQrUrl, fatura_id: fatura.id };
  }

  // Cartão confirma na hora (sem espera de webhook) — diferente do Pix
  private async pagarFaturaCartao(
    fatura: any,
    body: { nome: string; email: string; cpf_cnpj: string; card_encrypted?: string; parcelas?: number },
    metodo: 'credit_card' | 'debit_card',
  ) {
    if (!body.card_encrypted) throw new BadRequestException('Dados do cartão ausentes');

    const { client, webhookUrl } = await this.clientPlataforma();
    const valorCentavos = Math.round(fatura.valor * 100);
    const refId = `PLANO_${fatura.id}_${Date.now()}`;

    let resposta: any;
    try {
      resposta = await client.criarOrdemCartao({
        reference_id: refId,
        valor_centavos: valorCentavos,
        customer: {
          name: body.nome,
          email: body.email,
          tax_id: body.cpf_cnpj.replace(/\D/g, ''),
        },
        itens: [{ name: `Assinatura — fatura #${fatura.id}`, quantity: 1, unit_amount: valorCentavos }],
        card_encrypted: body.card_encrypted,
        parcelas: metodo === 'credit_card' ? (body.parcelas ?? 1) : 1,
        tipo: metodo === 'credit_card' ? 'CREDIT_CARD' : 'DEBIT_CARD',
        webhook_url: webhookUrl,
      });
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao processar cartão no PagBank');
    }

    const charge = resposta?.charges?.[0];
    const pago = STATUS_PAGOS.includes(charge?.status);

    const { error } = await this.supabase.client
      .from('plano_faturas')
      .update({
        pagbank_order_id: resposta.id,
        reference_id: refId,
        status: pago ? 'paga' : fatura.status,
        pago_em: pago ? new Date().toISOString() : null,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', fatura.id);
    if (error) throw error;

    if (!pago) {
      throw new BadRequestException(charge?.status === 'DECLINED' ? 'Cartão recusado' : 'Pagamento não aprovado, tente novamente');
    }

    await this.aplicarTrocaSeNecessario(fatura);

    return { pago: true, fatura_id: fatura.id };
  }

  async processarWebhook(evento: any) {
    const payload = evento?.data ?? evento;
    const pagbankOrderId: string = payload?.id ?? payload?.reference_id;
    const charges: any[] = payload?.charges ?? [];
    const payments: any[] = payload?.payments ?? [];

    const detalhe = charges[0] ?? payments[0];
    if (!detalhe) return { ignorado: true };

    const statusPagbank: string = detalhe?.status ?? payload?.status ?? '';
    if (!STATUS_PAGOS.includes(statusPagbank)) return { ignorado: true };

    const { data: fatura } = await this.supabase.client
      .from('plano_faturas')
      .select('id, status, restaurant_id, plano_id_troca')
      .eq('pagbank_order_id', pagbankOrderId)
      .maybeSingle();

    if (!fatura) return { ignorado: true, motivo: 'fatura não encontrada' };
    if (fatura.status === 'paga') return { ignorado: true, motivo: 'já processado' };

    await this.supabase.client
      .from('plano_faturas')
      .update({ status: 'paga', pago_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq('id', fatura.id);

    await this.aplicarTrocaSeNecessario(fatura);

    return { processado: true, fatura_id: fatura.id };
  }
}

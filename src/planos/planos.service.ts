import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PagBankClient } from '../pagamentos/pagbank.client';
import { CriarPlanoDto } from './dto/criar-plano.dto';
import { AtualizarPlanoDto } from './dto/atualizar-plano.dto';

const STATUS_PAGOS = ['PAID', 'COMPLETED', 'AVAILABLE'];

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

  async criarPlano(body: CriarPlanoDto) {
    const { data, error } = await this.supabase.client
      .from('planos')
      .insert({
        nome: body.nome,
        valor: body.valor,
        periodicidade: body.periodicidade,
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
    const campos: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.nome !== undefined) campos.nome = body.nome;
    if (body.valor !== undefined) campos.valor = body.valor;
    if (body.periodicidade !== undefined) campos.periodicidade = body.periodicidade;
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

  private async buscarAssinaturaRaw(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('assinaturas')
      .select('*, planos(*)')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async buscarAssinaturaPorRestaurante(restaurantId: number) {
    const assinatura = await this.buscarAssinaturaRaw(restaurantId);
    if (!assinatura) throw new NotFoundException('Loja não tem assinatura');

    const { data: faturas, error } = await this.supabase.client
      .from('plano_faturas')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('periodo_inicio', { ascending: false });
    if (error) throw error;

    return { assinatura, faturas: faturas ?? [] };
  }

  async atribuirAssinatura(restaurantId: number, planoId: number) {
    const plano = await this.buscarPlano(planoId);

    const { data: restaurante, error: restErro } = await this.supabase.client
      .from('restaurants').select('id').eq('id', restaurantId).maybeSingle();
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
      .eq('id', restaurantId);
    if (moduloErro) throw moduloErro;

    const existente = await this.buscarAssinaturaRaw(restaurantId);
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

    const { data, error } = await this.supabase.client
      .from('assinaturas')
      .insert({
        restaurant_id: restaurantId,
        plano_id: planoId,
        status: temTrial ? 'trial' : 'ativa',
        data_inicio: agora.toISOString(),
        trial_fim: trialFim?.toISOString() ?? null,
        ultimo_periodo_faturado_fim: (trialFim ?? agora).toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async cancelarAssinatura(restaurantId: number) {
    const existente = await this.buscarAssinaturaRaw(restaurantId);
    if (!existente) throw new NotFoundException('Loja não tem assinatura');

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
    const assinatura = await this.buscarAssinaturaRaw(restaurantId);
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
  async sincronizarPeriodo(restaurantId: number, forcar = false) {
    const assinatura = await this.buscarAssinaturaRaw(restaurantId);
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

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const fimPeriodo = somarMeses(inicioPeriodo, meses);
      const periodoFechado = fimPeriodo < agora;
      if (!periodoFechado && !forcar) break;

      if (!periodoFechado) {
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

      const { data: faturamentoRows, error: fatErro } = await this.supabase.client
        .from('orders')
        .select('total')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'delivered')
        .gte('created_at', inicioPeriodo.toISOString())
        .lt('created_at', fimPeriodo.toISOString());
      if (fatErro) throw fatErro;

      const faturamento = (faturamentoRows ?? []).reduce((acc, o: any) => acc + (o.total ?? 0), 0);

      const isento = plano.piso_faturamento != null && faturamento < plano.piso_faturamento;
      const valorFatura = isento ? 0 : plano.valor;
      const vencimento = somarDias(fimPeriodo, 5);

      const { error: insErro } = await this.supabase.client
        .from('plano_faturas')
        .insert({
          assinatura_id: assinatura.id,
          restaurant_id: restaurantId,
          periodo_inicio: inicioPeriodo.toISOString(),
          periodo_fim: fimPeriodo.toISOString(),
          valor: valorFatura,
          status: isento ? 'isenta' : 'pendente',
          vencimento: vencimento.toISOString(),
        });
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
    const status = await this.sincronizarPeriodo(restaurantId);
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
    await this.sincronizarPeriodo(restaurantId, true);
    return this.buscarAssinaturaPorRestaurante(restaurantId);
  }

  // Dono renovando/antecipando a cobrança da própria loja pelo painel do plano
  async renovarAgora(restaurantId: number) {
    return this.sincronizarPeriodo(restaurantId, true);
  }

  // ── Faturas (visão admin) ───────────────────────────────────────

  async listarFaturas(filtros: { restaurant_id?: number; status?: string }) {
    let q = this.supabase.client
      .from('plano_faturas')
      .select('*, restaurants(name)')
      .order('vencimento', { ascending: false });
    if (filtros.restaurant_id) q = q.eq('restaurant_id', filtros.restaurant_id);
    if (filtros.status) q = q.eq('status', filtros.status);
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

  async pagarFatura(restaurantId: number, faturaId: number, customer: { nome: string; email: string; cpf_cnpj: string }) {
    const fatura = await this.buscarFaturaDoRestaurante(restaurantId, faturaId);
    if (fatura.status === 'paga') throw new BadRequestException('Fatura já está paga');
    if (fatura.status === 'isenta' || fatura.status === 'cancelada') {
      throw new BadRequestException('Esta fatura não pode ser paga');
    }

    // Reaproveita o QR já gerado pra essa fatura em vez de abrir ordem nova a cada clique
    if (fatura.pix_code && fatura.pagbank_order_id) {
      return { pix_code: fatura.pix_code, pix_qr_url: fatura.pix_qr_url, fatura_id: fatura.id };
    }

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

    const valorCentavos = Math.round(fatura.valor * 100);
    const refId = `PLANO_${fatura.id}_${Date.now()}`;
    const client = new PagBankClient(token, sandbox);

    let resposta: any;
    try {
      resposta = await client.criarOrdemPix({
        reference_id: refId,
        valor_centavos: valorCentavos,
        customer: {
          name: customer.nome,
          email: customer.email,
          tax_id: customer.cpf_cnpj.replace(/\D/g, ''),
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
      .select('id, status')
      .eq('pagbank_order_id', pagbankOrderId)
      .maybeSingle();

    if (!fatura) return { ignorado: true, motivo: 'fatura não encontrada' };
    if (fatura.status === 'paga') return { ignorado: true, motivo: 'já processado' };

    await this.supabase.client
      .from('plano_faturas')
      .update({ status: 'paga', pago_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq('id', fatura.id);

    return { processado: true, fatura_id: fatura.id };
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { TagsService } from '../tags/tags.service';
import { PagBankClient } from '../pagamentos/pagbank.client';
import { CriarPacoteDto } from './dto/criar-pacote.dto';
import { AtualizarPacoteDto } from './dto/atualizar-pacote.dto';

const STATUS_PAGOS = ['PAID', 'COMPLETED', 'AVAILABLE'];
const VAGAS_PADRAO = 3;

const somarDias = (data: Date, dias: number) => {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d;
};

@Injectable()
export class MarketplaceBoostService {
  constructor(
    private supabase: SupabaseService,
    private tags: TagsService,
    private config: ConfigService,
  ) {}

  // ── Carrosséis vendáveis: "combos" (fixo) + qualquer tag ativa de
  // tags_catalogo (dinâmico — admin cria tag nova, ela já vira vendável aqui
  // sem precisar de deploy). carrossel = slug da tag, ou 'combos'. ──

  async listarCarrosseisDisponiveis(): Promise<{ carrossel: string; label: string }[]> {
    const { tags } = await this.tags.listar(true);
    return [
      { carrossel: 'combos', label: 'Combos' },
      ...tags.map((t: any) => ({ carrossel: t.slug, label: t.name })),
    ];
  }

  private async validarCarrossel(carrossel: string) {
    const disponiveis = await this.listarCarrosseisDisponiveis();
    if (!disponiveis.some((c) => c.carrossel === carrossel)) {
      throw new BadRequestException(`Carrossel "${carrossel}" não existe (crie a tag em /admin/tags primeiro, se não for "combos")`);
    }
  }

  // ── Config de vagas (platform_settings.config.marketplace_slots) ──

  async vagasConfiguradas(): Promise<Record<string, number>> {
    const [{ data }, carrosseis] = await Promise.all([
      this.supabase.client.from('platform_settings').select('config').eq('id', 1).maybeSingle(),
      this.listarCarrosseisDisponiveis(),
    ]);
    const cfg = (data?.config ?? {}) as Record<string, any>;
    const slots = cfg.marketplace_slots ?? {};
    const resultado: Record<string, number> = {};
    for (const c of carrosseis) resultado[c.carrossel] = Number(slots[c.carrossel] ?? VAGAS_PADRAO);
    return resultado;
  }

  async salvarVagas(vagas: Record<string, number>) {
    const { data: atual } = await this.supabase.client
      .from('platform_settings').select('config').eq('id', 1).maybeSingle();
    const cfg = (atual?.config ?? {}) as Record<string, any>;
    const slotsAtuais = cfg.marketplace_slots ?? {};
    const novo = { ...cfg, marketplace_slots: { ...slotsAtuais, ...vagas } };

    const { error } = await this.supabase.client
      .from('platform_settings')
      .update({ config: novo, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw error;
    return this.vagasConfiguradas();
  }

  // Perfis nomeados de vagas (ex: "Padrão", "Black Friday") — só um registro
  // congelado da configuração no momento de salvar, não tem conceito de
  // "ativo"; aplicar um preset só chama salvarVagas() de novo com o config dele.
  async listarPresetsVagas() {
    const { data, error } = await this.supabase.client
      .from('marketplace_boost_vagas_presets')
      .select('*')
      .order('criado_em', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async criarPresetVagas(nome: string, config: Record<string, number>) {
    const { data, error } = await this.supabase.client
      .from('marketplace_boost_vagas_presets')
      .insert({ nome, config })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removerPresetVagas(id: number) {
    const { error } = await this.supabase.client.from('marketplace_boost_vagas_presets').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  async aplicarPresetVagas(id: number) {
    const { data: preset } = await this.supabase.client
      .from('marketplace_boost_vagas_presets').select('config').eq('id', id).maybeSingle();
    if (!preset) throw new NotFoundException('Perfil de vagas não encontrado');
    return this.salvarVagas(preset.config as Record<string, number>);
  }

  // Vagas ocupadas de TODOS os carrosséis numa query só — uma campanha
  // (marketplace_boosts.itens) pode cobrir vários carrosséis ao mesmo tempo,
  // então não dá mais pra filtrar por 1 carrossel direto na query.
  private async vagasOcupadasTodas(): Promise<Record<string, number>> {
    const { data, error } = await this.supabase.client
      .from('marketplace_boosts')
      .select('itens')
      .not('pago_em', 'is', null)
      .gt('fim_em', new Date().toISOString());
    if (error) throw error;

    const ocupadas: Record<string, number> = {};
    for (const b of (data ?? []) as any[]) {
      for (const [carrossel, ids] of Object.entries(b.itens ?? {})) {
        ocupadas[carrossel] = (ocupadas[carrossel] ?? 0) + (Array.isArray(ids) ? ids.length : 0);
      }
    }
    return ocupadas;
  }

  // ── Pacotes (CRUD admin) ──

  async listarPacotesAdmin() {
    const { data, error } = await this.supabase.client
      .from('marketplace_boost_pacotes').select('*').order('preco');
    if (error) throw error;
    return { pacotes: data ?? [] };
  }

  // Composição do pacote (carrossel -> quantidade) vem sempre de um perfil de
  // vagas salvo, congelada no momento da criação — igual ao mesmo padrão já
  // usado em aplicarPresetVagas (snapshot, não referência viva ao preset).
  private async buscarPresetVagas(id: number): Promise<Record<string, number>> {
    const { data } = await this.supabase.client
      .from('marketplace_boost_vagas_presets').select('config').eq('id', id).maybeSingle();
    if (!data) throw new NotFoundException('Perfil de vagas não encontrado');
    const config = (data.config ?? {}) as Record<string, number>;
    if (Object.keys(config).length === 0) throw new BadRequestException('Perfil de vagas está vazio');
    return config;
  }

  async criarPacote(body: CriarPacoteDto) {
    const config = await this.buscarPresetVagas(body.preset_id);
    for (const carrossel of Object.keys(config)) await this.validarCarrossel(carrossel);

    const { data, error } = await this.supabase.client
      .from('marketplace_boost_pacotes')
      .insert({
        nome: body.nome,
        config,
        dias: body.dias,
        preco: body.preco,
        ativo: body.ativo ?? true,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async atualizarPacote(id: number, body: AtualizarPacoteDto) {
    const campos: Record<string, any> = {};
    if (body.nome !== undefined) campos.nome = body.nome;
    if (body.dias !== undefined) campos.dias = body.dias;
    if (body.preco !== undefined) campos.preco = body.preco;
    if (body.ativo !== undefined) campos.ativo = body.ativo;

    const { data, error } = await this.supabase.client
      .from('marketplace_boost_pacotes').update(campos).eq('id', id).select().single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Pacote não encontrado');
    return data;
  }

  async removerPacote(id: number) {
    const { count } = await this.supabase.client
      .from('marketplace_boosts').select('id', { count: 'exact', head: true }).eq('pacote_id', id);
    if ((count ?? 0) > 0) {
      throw new ConflictException('Este pacote já foi comprado por algum restaurante — desative com "ativo: false" em vez de remover');
    }
    const { error } = await this.supabase.client.from('marketplace_boost_pacotes').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Lado dono ──

  // Ids de pacotes que vêm inclusos de graça no plano atual do restaurante
  // (assinatura não cancelada) — vazio se não tiver assinatura ou não
  // informar restaurantId (uso pelo admin, sem contexto de restaurante).
  private async pacotesInclusosDoRestaurante(restaurantId?: number): Promise<Set<number>> {
    if (!restaurantId) return new Set();
    const { data: assinatura } = await this.supabase.client
      .from('assinaturas').select('plano_id, status').eq('restaurant_id', restaurantId).maybeSingle();
    if (!assinatura || assinatura.status === 'cancelada') return new Set();

    const { data: vinculos } = await this.supabase.client
      .from('plano_pacotes_boost').select('pacote_id').eq('plano_id', assinatura.plano_id);
    return new Set((vinculos ?? []).map((v: any) => v.pacote_id));
  }

  // Lista pacotes ativos com vagas restantes calculadas — dono só vê o que
  // ainda cabe comprar. Um pacote agora pode cobrir vários carrosséis (sua
  // "composição", vinda do preset congelado em config); só é comprável
  // (disponivel=true) se TODOS os carrosséis da composição ainda tiverem
  // vaga suficiente pra quantidade exigida naquele carrossel. Quando chamado
  // com restaurantId (lado do dono), marca os pacotes que já vêm de graça no
  // plano atual dele.
  async listarPacotesDisponiveis(restaurantId?: number) {
    const [{ data: pacotes, error }, vagasConfig, carrosseis, ocupadas, inclusos] = await Promise.all([
      this.supabase.client.from('marketplace_boost_pacotes').select('*').eq('ativo', true).order('preco'),
      this.vagasConfiguradas(),
      this.listarCarrosseisDisponiveis(),
      this.vagasOcupadasTodas(),
      this.pacotesInclusosDoRestaurante(restaurantId),
    ]);
    if (error) throw error;

    const labelPorCarrossel = Object.fromEntries(carrosseis.map((c) => [c.carrossel, c.label]));

    return {
      pacotes: (pacotes ?? []).map((p: any) => {
        const config = (p.config ?? {}) as Record<string, number>;
        const composicao = Object.entries(config).map(([carrossel, qtd]) => ({
          carrossel,
          label: labelPorCarrossel[carrossel] ?? carrossel,
          qtd,
          vagas_disponiveis: Math.max(0, (vagasConfig[carrossel] ?? VAGAS_PADRAO) - (ocupadas[carrossel] ?? 0)),
        }));
        return {
          ...p,
          composicao,
          incluso_no_plano: inclusos.has(p.id),
          disponivel: composicao.every((c) => c.vagas_disponiveis >= c.qtd),
        };
      }),
    };
  }

  async meusBoosts(restaurantId: number) {
    const [{ data, error }, carrosseis] = await Promise.all([
      this.supabase.client
        .from('marketplace_boosts')
        .select('*, marketplace_boost_pacotes(nome, dias)')
        .eq('restaurant_id', restaurantId)
        .order('created_at', { ascending: false }),
      this.listarCarrosseisDisponiveis(),
    ]);
    if (error) throw error;

    const labelPorCarrossel = Object.fromEntries(carrosseis.map((c) => [c.carrossel, c.label]));
    return {
      boosts: (data ?? []).map((b: any) => ({
        ...b,
        composicao: Object.entries(b.itens ?? {}).map(([carrossel, ids]: [string, any]) => ({
          carrossel,
          label: labelPorCarrossel[carrossel] ?? carrossel,
          qtd: Array.isArray(ids) ? ids.length : 0,
        })),
      })),
    };
  }

  private async buscarPacote(id: number) {
    const { data } = await this.supabase.client
      .from('marketplace_boost_pacotes').select('*').eq('id', id).maybeSingle();
    if (!data || !data.ativo) throw new NotFoundException('Pacote não encontrado ou inativo');
    return data;
  }

  private async validarItensDoRestaurante(restaurantId: number, carrossel: string, itemIds: number[]) {
    const tabela = carrossel === 'combos' ? 'combos' : 'products';
    const { data, error } = await this.supabase.client
      .from(tabela).select('id').eq('restaurant_id', restaurantId).in('id', itemIds);
    if (error) throw error;
    if ((data ?? []).length !== itemIds.length) {
      throw new ForbiddenException('Um ou mais itens selecionados não pertencem a este restaurante');
    }
  }

  // Itens vendáveis de uma empresa num carrossel — usado pelo admin pra
  // montar uma campanha em nome da empresa (mesma tabela que o dono vê nas
  // suas próprias telas de produtos/combos).
  async listarItensVendaveis(restaurantId: number, carrossel: string) {
    const tabela = carrossel === 'combos' ? 'combos' : 'products';
    const { data, error } = await this.supabase.client
      .from(tabela).select('id, name, price, preco_promo').eq('restaurant_id', restaurantId);
    if (error) throw error;
    return data ?? [];
  }

  async criarBoost(
    restaurantId: number,
    pacoteId: number,
    itens: Record<string, number[]>,
    opts: { cortesiaAdmin?: boolean } = {},
  ) {
    const pacote = await this.buscarPacote(pacoteId);
    const config = (pacote.config ?? {}) as Record<string, number>;
    const carrosseisConfig = Object.keys(config);
    const carrosseisRecebidos = Object.keys(itens ?? {});

    if (
      carrosseisRecebidos.length !== carrosseisConfig.length ||
      !carrosseisConfig.every((c) => carrosseisRecebidos.includes(c))
    ) {
      throw new BadRequestException('Selecione itens para todos os carrosséis deste pacote');
    }

    for (const carrossel of carrosseisConfig) {
      const ids = itens[carrossel] ?? [];
      if (ids.length !== config[carrossel]) {
        throw new BadRequestException(`Este pacote exige exatamente ${config[carrossel]} item(ns) em "${carrossel}"`);
      }
      await this.validarItensDoRestaurante(restaurantId, carrossel, ids);
    }

    const vagasConfig = await this.vagasConfiguradas();
    const ocupadas = await this.vagasOcupadasTodas();
    for (const carrossel of carrosseisConfig) {
      if ((ocupadas[carrossel] ?? 0) + config[carrossel] > (vagasConfig[carrossel] ?? VAGAS_PADRAO)) {
        throw new ConflictException(`Sem vagas suficientes em "${carrossel}" no momento`);
      }
    }

    // Campanha já nasce paga (sem passar pelo PagBank) quando concedida pelo
    // admin (cortesia/venda manual) OU quando o pacote vem incluso de graça
    // no plano atual do restaurante.
    const gratis = opts.cortesiaAdmin || (await this.pacotesInclusosDoRestaurante(restaurantId)).has(pacoteId);
    const agora = new Date();
    const camposCortesia = gratis
      ? { pago_em: agora.toISOString(), fim_em: somarDias(agora, pacote.dias).toISOString() }
      : {};

    const { data, error } = await this.supabase.client
      .from('marketplace_boosts')
      .insert({
        restaurant_id: restaurantId,
        pacote_id: pacote.id,
        itens,
        valor_centavos: Math.round(Number(pacote.preco) * 100),
        ...camposCortesia,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // Encerra uma campanha antes do prazo (admin) — mantém o histórico, só
  // libera a vaga imediatamente em vez de esperar o fim_em original.
  async encerrarBoost(boostId: number) {
    const { data, error } = await this.supabase.client
      .from('marketplace_boosts')
      .update({ fim_em: new Date().toISOString() })
      .eq('id', boostId)
      .select()
      .single();
    if (error) throw error;
    if (!data) throw new NotFoundException('Campanha não encontrada');
    return data;
  }

  // Remove de vez uma campanha que ainda não foi paga — "encerrar" não serve
  // pra esse caso, pois nunca teve fim_em calculado. Uma campanha já paga tem
  // histórico de cobrança real (PagBank ou cortesia) e deve ser encerrada,
  // não apagada. `restaurantId` opcional restringe ao dono (lado do
  // restaurante); omitido, é a versão irrestrita (admin).
  private async removerBoostNaoPagoInterno(boostId: number, restaurantId?: number) {
    const { data: boost } = await this.supabase.client
      .from('marketplace_boosts').select('id, pago_em, restaurant_id').eq('id', boostId).maybeSingle();
    if (!boost || (restaurantId !== undefined && boost.restaurant_id !== restaurantId)) {
      throw new NotFoundException('Campanha não encontrada');
    }
    if (boost.pago_em) throw new ConflictException('Campanha já paga não pode ser excluída — encerre em vez disso');

    const { error } = await this.supabase.client.from('marketplace_boosts').delete().eq('id', boostId);
    if (error) throw error;
    return { ok: true };
  }

  async removerBoostNaoPago(boostId: number) {
    return this.removerBoostNaoPagoInterno(boostId);
  }

  async removerBoostNaoPagoDoRestaurante(restaurantId: number, boostId: number) {
    return this.removerBoostNaoPagoInterno(boostId, restaurantId);
  }

  async buscarBoostDoRestaurante(restaurantId: number, boostId: number) {
    const { data } = await this.supabase.client
      .from('marketplace_boosts').select('*').eq('id', boostId).eq('restaurant_id', restaurantId).maybeSingle();
    if (!data) throw new NotFoundException('Campanha não encontrada');
    return data;
  }

  // ── Pagamento via PagBank (cobrança direta loja -> plataforma, sem split) —
  // mesmo padrão de PlanosService.pagarFatura/clientPlataforma, webhook próprio. ──

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
    const webhookUrl = baseWebhook.replace('/pagamentos/webhook', '/marketplace-boost/webhook');

    return { client: new PagBankClient(token, sandbox), webhookUrl };
  }

  async pagarBoost(
    restaurantId: number,
    boostId: number,
    body: { nome: string; email: string; cpf_cnpj: string; metodo?: 'pix' | 'credit_card' | 'debit_card'; card_encrypted?: string; parcelas?: number },
  ) {
    const boost = await this.buscarBoostDoRestaurante(restaurantId, boostId);
    if (boost.pago_em) throw new BadRequestException('Campanha já está paga');

    const metodo = body.metodo ?? 'pix';
    if (metodo === 'credit_card' || metodo === 'debit_card') {
      return this.pagarBoostCartao(boost, body, metodo);
    }

    if (boost.pix_code && boost.pagbank_order_id) {
      return { pix_code: boost.pix_code, pix_qr_url: boost.pix_qr_url, boost_id: boost.id };
    }

    const { client, webhookUrl } = await this.clientPlataforma();
    const refId = `BOOST_${boost.id}_${Date.now()}`;

    let resposta: any;
    try {
      resposta = await client.criarOrdemPix({
        reference_id: refId,
        valor_centavos: boost.valor_centavos,
        customer: { name: body.nome, email: body.email, tax_id: body.cpf_cnpj.replace(/\D/g, '') },
        itens: [{ name: `Destaque no marketplace — campanha #${boost.id}`, quantity: 1, unit_amount: boost.valor_centavos }],
        webhook_url: webhookUrl,
      });
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao gerar cobrança no PagBank');
    }

    const qrCode = resposta?.qr_codes?.[0];
    const pixCode = qrCode?.text ?? null;
    const pixQrUrl = qrCode?.links?.find((l: any) => l.media === 'image/png')?.href ?? null;

    const { error } = await this.supabase.client
      .from('marketplace_boosts')
      .update({ pagbank_order_id: resposta.id, reference_id: refId, pix_code: pixCode, pix_qr_url: pixQrUrl })
      .eq('id', boost.id);
    if (error) throw error;

    return { pix_code: pixCode, pix_qr_url: pixQrUrl, boost_id: boost.id };
  }

  private async pagarBoostCartao(
    boost: any,
    body: { nome: string; email: string; cpf_cnpj: string; card_encrypted?: string; parcelas?: number },
    metodo: 'credit_card' | 'debit_card',
  ) {
    if (!body.card_encrypted) throw new BadRequestException('Dados do cartão ausentes');

    const { client, webhookUrl } = await this.clientPlataforma();
    const refId = `BOOST_${boost.id}_${Date.now()}`;

    let resposta: any;
    try {
      resposta = await client.criarOrdemCartao({
        reference_id: refId,
        valor_centavos: boost.valor_centavos,
        customer: { name: body.nome, email: body.email, tax_id: body.cpf_cnpj.replace(/\D/g, '') },
        itens: [{ name: `Destaque no marketplace — campanha #${boost.id}`, quantity: 1, unit_amount: boost.valor_centavos }],
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
    const agora = new Date();

    const { error } = await this.supabase.client
      .from('marketplace_boosts')
      .update({
        pagbank_order_id: resposta.id,
        reference_id: refId,
        pago_em: pago ? agora.toISOString() : null,
        fim_em: pago ? somarDias(agora, (boost.marketplace_boost_pacotes?.dias) ?? await this.diasDoPacote(boost.pacote_id)).toISOString() : null,
      })
      .eq('id', boost.id);
    if (error) throw error;

    if (!pago) {
      throw new BadRequestException(charge?.status === 'DECLINED' ? 'Cartão recusado' : 'Pagamento não aprovado, tente novamente');
    }

    return { pago: true, boost_id: boost.id };
  }

  private async diasDoPacote(pacoteId: number): Promise<number> {
    const { data } = await this.supabase.client
      .from('marketplace_boost_pacotes').select('dias').eq('id', pacoteId).maybeSingle();
    return data?.dias ?? 7;
  }

  async processarWebhook(evento: any) {
    const payload = evento?.data ?? evento;
    const pagbankOrderId: string = payload?.id ?? payload?.reference_id;
    if (!pagbankOrderId) return { ignorado: true };

    const { data: boost } = await this.supabase.client
      .from('marketplace_boosts')
      .select('id, pago_em, pacote_id')
      .eq('pagbank_order_id', pagbankOrderId)
      .maybeSingle();

    if (!boost) return { ignorado: true, motivo: 'campanha não encontrada' };
    if (boost.pago_em) return { ignorado: true, motivo: 'já processado' };

    // PagBank não assina notificações — nunca confiar no status vindo no corpo
    // do POST, reconsulta a ordem direto na API antes de confirmar.
    const { client } = await this.clientPlataforma();
    const ordemReal = await client.buscarOrdem(pagbankOrderId);
    const detalhe = ordemReal?.charges?.[0] ?? ordemReal?.payments?.[0];
    if (!detalhe) return { ignorado: true };

    const statusPagbank: string = detalhe?.status ?? '';
    if (!STATUS_PAGOS.includes(statusPagbank)) return { ignorado: true };

    const dias = await this.diasDoPacote(boost.pacote_id);
    const agora = new Date();

    const { error } = await this.supabase.client
      .from('marketplace_boosts')
      .update({ pago_em: agora.toISOString(), fim_em: somarDias(agora, dias).toISOString() })
      .eq('id', boost.id);
    if (error) throw error;

    return { processado: true };
  }
}

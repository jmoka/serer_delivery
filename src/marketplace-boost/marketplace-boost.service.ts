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

  private async vagasOcupadas(carrossel: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('marketplace_boosts')
      .select('item_ids')
      .eq('carrossel', carrossel)
      .not('pago_em', 'is', null)
      .gt('fim_em', new Date().toISOString());
    if (error) throw error;
    return (data ?? []).reduce((soma, b: any) => soma + (b.item_ids?.length ?? 0), 0);
  }

  // ── Pacotes (CRUD admin) ──

  async listarPacotesAdmin() {
    const { data, error } = await this.supabase.client
      .from('marketplace_boost_pacotes').select('*').order('carrossel').order('preco');
    if (error) throw error;
    return { pacotes: data ?? [] };
  }

  async criarPacote(body: CriarPacoteDto) {
    await this.validarCarrossel(body.carrossel);
    const { data, error } = await this.supabase.client
      .from('marketplace_boost_pacotes')
      .insert({
        nome: body.nome,
        carrossel: body.carrossel,
        qtd_produtos: body.qtd_produtos,
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
    if (body.qtd_produtos !== undefined) campos.qtd_produtos = body.qtd_produtos;
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

  // Lista pacotes ativos com vagas restantes calculadas — dono só vê o que ainda cabe comprar.
  async listarPacotesDisponiveis() {
    const [{ data: pacotes, error }, vagasConfig, carrosseis] = await Promise.all([
      this.supabase.client.from('marketplace_boost_pacotes').select('*').eq('ativo', true).order('carrossel').order('preco'),
      this.vagasConfiguradas(),
      this.listarCarrosseisDisponiveis(),
    ]);
    if (error) throw error;

    const labelPorCarrossel = Object.fromEntries(carrosseis.map((c) => [c.carrossel, c.label]));
    const carrosseisComPacote = [...new Set((pacotes ?? []).map((p: any) => p.carrossel))];
    const ocupadasPorCarrossel: Record<string, number> = {};
    for (const c of carrosseisComPacote) ocupadasPorCarrossel[c as string] = await this.vagasOcupadas(c as string);

    return {
      pacotes: (pacotes ?? []).map((p: any) => ({
        ...p,
        carrossel_label: labelPorCarrossel[p.carrossel] ?? p.carrossel,
        vagas_disponiveis: Math.max(0, (vagasConfig[p.carrossel] ?? VAGAS_PADRAO) - ocupadasPorCarrossel[p.carrossel]),
      })),
    };
  }

  async meusBoosts(restaurantId: number) {
    const [{ data, error }, carrosseis] = await Promise.all([
      this.supabase.client
        .from('marketplace_boosts')
        .select('*, marketplace_boost_pacotes(nome, carrossel, qtd_produtos, dias)')
        .eq('restaurant_id', restaurantId)
        .order('created_at', { ascending: false }),
      this.listarCarrosseisDisponiveis(),
    ]);
    if (error) throw error;

    const labelPorCarrossel = Object.fromEntries(carrosseis.map((c) => [c.carrossel, c.label]));
    return {
      boosts: (data ?? []).map((b: any) => ({ ...b, carrossel_label: labelPorCarrossel[b.carrossel] ?? b.carrossel })),
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

  async criarBoost(restaurantId: number, pacoteId: number, itemIds: number[]) {
    const pacote = await this.buscarPacote(pacoteId);
    if (itemIds.length !== pacote.qtd_produtos) {
      throw new BadRequestException(`Este pacote exige exatamente ${pacote.qtd_produtos} item(ns) selecionado(s)`);
    }
    await this.validarItensDoRestaurante(restaurantId, pacote.carrossel, itemIds);

    const vagasConfig = await this.vagasConfiguradas();
    const ocupadas = await this.vagasOcupadas(pacote.carrossel);
    if (ocupadas + itemIds.length > (vagasConfig[pacote.carrossel] ?? VAGAS_PADRAO)) {
      throw new ConflictException('Sem vagas suficientes nesse carrossel no momento');
    }

    const { data, error } = await this.supabase.client
      .from('marketplace_boosts')
      .insert({
        restaurant_id: restaurantId,
        pacote_id: pacote.id,
        carrossel: pacote.carrossel,
        item_ids: itemIds,
        valor_centavos: Math.round(Number(pacote.preco) * 100),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { EncryptionService } from '../common/encryption.service';
import { WhatsappClient } from './whatsapp.client';
import { MotoboyAcaoLinkService } from '../motoboy/motoboy-acao-link.service';
import { PedidoTrackingLinkService } from '../pedidos/pedido-tracking-link.service';

const TOKEN_TTL_MS = 30 * 60 * 1000;

const formatarMoeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v ?? 0);

// Fallback só usado se MARKETPLACE_BASE_URL não estiver setada no ambiente — mesmo
// padrão de catalogo.controller.ts.
const MARKETPLACE_BASE_URL = process.env.MARKETPLACE_BASE_URL ?? 'https://pediuvai.teucurso.top';

const PAGAMENTO_LABEL: Record<string, string> = {
  pix: 'PIX',
  credit_card: 'Cartão crédito',
  debit_card: 'Cartão débito',
  cash: 'Dinheiro (na entrega)',
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly client: WhatsappClient | null;
  private readonly numeroBot: string;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private encryption: EncryptionService,
    private acaoLink: MotoboyAcaoLinkService,
    private trackingLink: PedidoTrackingLinkService,
  ) {
    const url = config.get<string>('EVOLUTION_URL');
    const key = config.get<string>('EVOLUTION_KEY');
    const instance = config.get<string>('EVOLUTION_INSTANCE') || 'Pediuvai';
    this.client = url && key ? new WhatsappClient(url, key, instance) : null;
    // Número conectado na instância Evolution — alvo fixo do deep-link wa.me (o
    // cliente abre conversa COM o bot, não o contrário).
    this.numeroBot = config.get<string>('EVOLUTION_WHATSAPP_NUMBER') || '5591984467027';
    if (!this.client) {
      this.logger.warn('EVOLUTION_URL/EVOLUTION_KEY não configuradas — notificações via WhatsApp vão ficar desligadas.');
    }
  }

  // Efeito colateral best-effort — nunca deixa uma falha de envio quebrar o fluxo
  // principal (confirmação de pagamento, entrega, cozinha). Erro só vira log.
  private async enviarMensagem(chatId: string | null | undefined, texto: string): Promise<void> {
    if (!chatId || !this.client) return;
    try {
      await this.client.sendText(chatId, texto);
    } catch (e: any) {
      this.logger.warn(`Falha ao enviar mensagem WhatsApp (chat ${chatId}): ${e.message}`);
    }
  }

  private async gerarLink(tipo: 'cliente' | 'motoboy' | 'estabelecimento', entidadeId: number) {
    // Só pode existir um token válido por entidade — gerar de novo invalida
    // qualquer link anterior ainda não resgatado.
    await this.supabase.client.from('whatsapp_link_tokens').delete().eq('tipo', tipo).eq('entidade_id', entidadeId);

    const token = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    const { error } = await this.supabase.client
      .from('whatsapp_link_tokens')
      .insert({ tipo, entidade_id: entidadeId, token, expira_em: expiraEm });
    if (error) throw error;

    const texto = encodeURIComponent(`/start ${token}`);
    return { token, deep_link: `https://wa.me/${this.numeroBot}?text=${texto}` };
  }

  gerarLinkCliente(customerId: number) {
    return this.gerarLink('cliente', customerId);
  }

  gerarLinkMotoboy(motoboyId: number) {
    return this.gerarLink('motoboy', motoboyId);
  }

  gerarLinkEstabelecimento(restaurantId: number) {
    return this.gerarLink('estabelecimento', restaurantId);
  }

  async statusCliente(customerId: number) {
    const { data } = await this.supabase.client
      .from('customers')
      .select('whatsapp_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    return { vinculado: !!data?.whatsapp_chat_id };
  }

  async statusMotoboy(motoboyId: number) {
    const { data } = await this.supabase.client
      .from('motoboys')
      .select('whatsapp_chat_id')
      .eq('id', motoboyId)
      .maybeSingle();
    return { vinculado: !!data?.whatsapp_chat_id };
  }

  async statusEstabelecimento(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('whatsapp_chat_id')
      .eq('id', restaurantId)
      .maybeSingle();
    return { vinculado: !!data?.whatsapp_chat_id };
  }

  // Chamado pelo node n8n que intercepta "/start <token>" antes do AI Agent (ver
  // workflow "PediuVai - WhatsApp"). Resgate apaga o token (não só marca usado) —
  // mesmo espírito do padrão do Telegram/cozinha-portal.
  async redimirToken(token: string, chatId: string) {
    const { data } = await this.supabase.client
      .from('whatsapp_link_tokens')
      .select('tipo, entidade_id, expira_em')
      .eq('token', token)
      .maybeSingle();

    if (!data || new Date(data.expira_em) < new Date()) {
      await this.enviarMensagem(chatId, 'Esse link expirou. Gere um novo no app e tente de novo.');
      return;
    }

    const tabelaPorTipo: Record<string, string> = {
      cliente: 'customers',
      motoboy: 'motoboys',
      estabelecimento: 'restaurants',
    };
    const tabela = tabelaPorTipo[data.tipo];
    await this.supabase.client.from(tabela).update({ whatsapp_chat_id: chatId }).eq('id', data.entidade_id);
    await this.supabase.client.from('whatsapp_link_tokens').delete().eq('token', token);

    if (data.tipo === 'cliente') {
      await this.enviarMensagem(
        chatId,
        '✅ WhatsApp vinculado! Bem-vindo(a) ao PediuVai 🎉\nAgora você vai receber por aqui a confirmação e o status dos seus pedidos.',
      );
      await this.enviarMensagem(
        chatId,
        '📍 Antes de fazer seu primeiro pedido, cadastre seu endereço no app e ajuste o pino no mapa exatamente onde fica sua casa. ' +
          'É isso que o motoboy usa pra chegar até você — só o endereço escrito não garante a entrega no lugar certo.',
      );
      return;
    }

    if (data.tipo === 'estabelecimento') {
      await this.enviarMensagem(
        chatId,
        '✅ WhatsApp vinculado! Bem-vindo ao PediuVai 🎉\nA partir de agora os avisos do seu estabelecimento chegam por aqui também.',
      );
      await this.enviarMensagem(
        chatId,
        '📍 Se ainda não ajustou, confirme o pino do endereço do seu estabelecimento no mapa (em Configurações) — ' +
          'é isso que o motoboy usa pra encontrar o local certo na hora da coleta.',
      );
      return;
    }

    await this.enviarMensagem(chatId, '✅ WhatsApp vinculado! Você vai receber as notificações do PediuVai por aqui.');
  }

  async avisarPedidoConfirmado(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const [{ data: cliente }, { data: itens }, { data: pedido }, { data: pagamento }] = await Promise.all([
      this.supabase.client.from('customers').select('whatsapp_chat_id').eq('id', customerId).maybeSingle(),
      this.supabase.client
        .from('order_items')
        .select('quantity, unit_price, combo_nome, combo_quantidade, products(name)')
        .eq('order_id', orderId),
      this.supabase.client
        .from('orders')
        .select('total, payment_method, retirada_balcao, frete_cobrado, frete_excedente_cobrado, frete_embutido_no_pedido, acrescimo_valor, desconto_valor, pago_em')
        .eq('id', orderId)
        .maybeSingle(),
      this.supabase.client.from('pagamentos').select('id').eq('order_id', orderId).eq('status', 'paid').maybeSingle(),
    ]);
    if (!cliente?.whatsapp_chat_id) return;

    const link = await this.trackingLink.gerarLink(orderId);
    await this.enviarMensagem(
      cliente.whatsapp_chat_id,
      this.montarResumoConfirmacao(orderId, itens ?? [], pedido, !!pedido?.pago_em || !!pagamento, link),
    );
  }

  private montarResumoConfirmacao(
    orderId: number,
    itens: any[],
    pedido: {
      total: number;
      payment_method: string;
      retirada_balcao: boolean;
      frete_cobrado: number;
      frete_excedente_cobrado: number;
      frete_embutido_no_pedido: boolean;
      acrescimo_valor: number;
      desconto_valor: number;
    } | null | undefined,
    pago: boolean,
    link: string | null,
  ): string {
    const linhas = itens.map((item) => {
      const nome = item.combo_nome ?? item.products?.name ?? 'Item';
      const qtd = item.combo_quantidade ?? item.quantity ?? 1;
      const valorLinha = Number(item.unit_price ?? 0) * Number(item.quantity ?? 1);
      return `${qtd}x ${nome} — ${formatarMoeda(valorLinha)}`;
    });

    const partes = [`✅ Pedido #${orderId} confirmado! Já entrou na fila de preparo.`];
    if (linhas.length) {
      partes.push('', '🧾 Itens:', ...linhas);
    }

    if (pedido) {
      const frete = parseFloat(String(pedido.frete_cobrado ?? 0));
      const excedente = parseFloat(String(pedido.frete_excedente_cobrado ?? 0));
      const acrescimo = parseFloat(String(pedido.acrescimo_valor ?? 0));
      const desconto = parseFloat(String(pedido.desconto_valor ?? 0));
      const detalhes: string[] = [];

      if (!pedido.retirada_balcao) {
        detalhes.push(`🚚 Frete: ${pedido.frete_embutido_no_pedido ? 'Grátis' : formatarMoeda(frete)}`);
        if (excedente > 0) detalhes.push(`📍 Excedente distância: ${formatarMoeda(excedente)}`);
      }
      if (acrescimo > 0) detalhes.push(`➕ Acréscimo: ${formatarMoeda(acrescimo)}`);
      if (desconto > 0) detalhes.push(`➖ Desconto: -${formatarMoeda(desconto)}`);
      if (detalhes.length) partes.push('', ...detalhes);

      partes.push('', `💰 Total: ${formatarMoeda(pedido.total)}`);
      partes.push(`💳 Pagamento: ${PAGAMENTO_LABEL[pedido.payment_method] ?? pedido.payment_method}`);
      partes.push(pago ? '✅ Pagamento já confirmado' : '🕒 Pagamento pendente');
    }

    if (link) {
      partes.push('', `🔗 Acompanhar pedido: ${link}`);
    }

    return partes.join('\n');
  }

  // Mensagem final do ciclo do pedido — agradecimento + link pra repetir/compartilhar
  // a loja + redes sociais do estabelecimento (se cadastradas em Config > Endereço).
  async avisarPedidoEntregue(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const { data: cliente } = await this.supabase.client
      .from('customers')
      .select('whatsapp_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    if (!cliente?.whatsapp_chat_id) return;

    const { data: pedido } = await this.supabase.client.from('orders').select('restaurant_id').eq('id', orderId).maybeSingle();
    const { data: restaurante } = pedido?.restaurant_id
      ? await this.supabase.client
          .from('restaurants')
          .select('slug, custom_domain, instagram_url, facebook_url')
          .eq('id', pedido.restaurant_id)
          .maybeSingle()
      : { data: null };

    await this.enviarMensagem(cliente.whatsapp_chat_id, this.montarMensagemEntregue(orderId, restaurante));
  }

  async avisarPedidoSaiuEntrega(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const { data } = await this.supabase.client
      .from('customers')
      .select('whatsapp_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    await this.enviarMensagem(data?.whatsapp_chat_id, `🛵 Pedido #${orderId} saiu para entrega!`);
  }

  // Só avisa quem já demonstrou interesse nesse pedido específico (pedido_interesses_motoboy)
  // — na hora que o pedido fica pronto ainda não existe motoboy_id atribuído, então não dá
  // pra mirar em "o" motoboy. Sem fallback de broadcast pra todo mundo (decisão de produto,
  // mesma do Telegram).
  // Endereço/distância/ganho/itens — mesmo bloco usado nas duas mensagens do motoboy
  // (concorrer e pegar), pro motoboy decidir se vale a corrida sem abrir o app. Ganho
  // estimado usa a mesma fórmula de MotoboyService.calcularGanhoEstimado (frete +
  // excedente de distância — nunca o total do pedido, que inclui o valor dos produtos).
  private async montarDetalhesCorrida(orderId: number): Promise<string> {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('distancia_entrega_km, frete_cobrado, frete_excedente_cobrado, customer_id')
      .eq('id', orderId)
      .maybeSingle();
    const { data: itens } = await this.supabase.client
      .from('order_items')
      .select('quantity, combo_nome, combo_quantidade, products(name)')
      .eq('order_id', orderId);

    let endereco: string | null = null;
    if (pedido?.customer_id) {
      const { data: cliente } = await this.supabase.client
        .from('customers')
        .select('address_json')
        .eq('id', pedido.customer_id)
        .maybeSingle();
      const addr = this.encryption.decryptJson(cliente?.address_json ?? null) ?? {};
      const linhaRua = [addr.logradouro, addr.numero].filter(Boolean).join(', ');
      const linhaCompl = [addr.complemento, addr.bairro].filter(Boolean).join(' — ');
      const linhaCidade = [addr.cidade, addr.estado, addr.cep].filter(Boolean).join(', ');
      endereco = [linhaRua, linhaCompl, linhaCidade].filter(Boolean).join(', ') || null;
    }

    const ganho = Math.round(((pedido?.frete_cobrado ?? 0) + (pedido?.frete_excedente_cobrado ?? 0)) * 100) / 100;
    const itensTexto = (itens ?? [])
      .map((i: any) => `${i.combo_quantidade ?? i.quantity ?? 1}x ${i.combo_nome ?? i.products?.name ?? 'Item'}`)
      .join(', ');

    const linhas = [`📍 Endereço: ${endereco ?? 'não informado'}`];
    if (pedido?.distancia_entrega_km != null) linhas.push(`📏 Distância: ${pedido.distancia_entrega_km} km`);
    linhas.push(`💰 Você ganha: ${formatarMoeda(ganho)}`);
    if (itensTexto) linhas.push(`🧾 Itens: ${itensTexto}`);
    return linhas.join('\n');
  }

  async avisarPedidoPronto(orderId: number) {
    const { data: interesses } = await this.supabase.client
      .from('pedido_interesses_motoboy')
      .select('motoboy_id')
      .eq('order_id', orderId);
    const motoboyIds = (interesses ?? []).map((i) => i.motoboy_id);
    if (!motoboyIds.length) return;

    const { data: motoboys } = await this.supabase.client
      .from('motoboys')
      .select('id, whatsapp_chat_id')
      .in('id', motoboyIds);

    const detalhes = await this.montarDetalhesCorrida(orderId);
    await Promise.all(
      (motoboys ?? []).map(async (m) => {
        const link = await this.acaoLink.gerarLink('pegar', orderId, m.id);
        const partes = [`🛵 Pedido #${orderId} está pronto pra retirada!`, '', detalhes];
        partes.push('', link ? `Toque pra aceitar e ir buscar:\n${link}` : 'Abra o app pra aceitar.');
        await this.enviarMensagem(m.whatsapp_chat_id, partes.join('\n'));
      }),
    );
  }

  // Avisa TODOS os motoboys afiliados/ativos da loja quando o pedido entra em produção
  // (status 'confirmed') — momento em que ele já pode demonstrar interesse (ver
  // MotoboyService.registrarInteresse). Link de um clique faz a ação direto, sem app.
  async avisarPedidoDisponivelMotoboy(orderId: number, restaurantId: number) {
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('usa_motoboy')
      .eq('id', restaurantId)
      .maybeSingle();
    if (!restaurante?.usa_motoboy) return;

    const { data: afiliacoes } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('motoboy_id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aceito')
      .eq('bloqueado', false);
    const motoboyIds = (afiliacoes ?? []).map((a) => a.motoboy_id);
    if (!motoboyIds.length) return;

    const { data: motoboys } = await this.supabase.client
      .from('motoboys')
      .select('id, whatsapp_chat_id')
      .in('id', motoboyIds);

    const detalhes = await this.montarDetalhesCorrida(orderId);
    await Promise.all(
      (motoboys ?? []).map(async (m) => {
        const link = await this.acaoLink.gerarLink('concorrer', orderId, m.id);
        const partes = [`📦 Novo pedido #${orderId} disponível!`, '', detalhes];
        partes.push('', link ? `Toque pra concorrer:\n${link}` : 'Abra o app pra concorrer.');
        await this.enviarMensagem(m.whatsapp_chat_id, partes.join('\n'));
      }),
    );
  }

  // Avisa o estabelecimento assim que o pedido delivery é criado (status 'pending',
  // antes de qualquer confirmação) — é o alerta que faz o dono abrir o painel, não
  // dá pra esperar o pedido ser confirmado pra avisar. Mensagem já vem com itens,
  // forma de pagamento e endereço pra não precisar abrir o painel só pra conferir.
  async avisarPedidoNovo(orderId: number, restaurantId: number) {
    const [{ data: restaurante }, { data: pedido }, { data: itens }] = await Promise.all([
      this.supabase.client.from('restaurants').select('whatsapp_chat_id').eq('id', restaurantId).maybeSingle(),
      this.supabase.client
        .from('orders')
        .select('total, payment_method, retirada_balcao, customer_id')
        .eq('id', orderId)
        .maybeSingle(),
      this.supabase.client
        .from('order_items')
        .select('quantity, unit_price, combo_nome, combo_quantidade, products(name)')
        .eq('order_id', orderId),
    ]);
    if (!restaurante?.whatsapp_chat_id) return;

    let endereco: string | null = null;
    if (pedido && !pedido.retirada_balcao && pedido.customer_id) {
      const { data: cliente } = await this.supabase.client
        .from('customers')
        .select('address_json')
        .eq('id', pedido.customer_id)
        .maybeSingle();
      const addr = this.encryption.decryptJson(cliente?.address_json ?? null) ?? {};
      const linhaRua = [addr.logradouro, addr.numero].filter(Boolean).join(', ');
      const linhaCompl = [addr.complemento, addr.bairro].filter(Boolean).join(' — ');
      const linhaCidade = [addr.cidade, addr.estado, addr.cep].filter(Boolean).join(', ');
      endereco = [linhaRua, linhaCompl, linhaCidade].filter(Boolean).join(', ') || null;
    }

    await this.enviarMensagem(restaurante.whatsapp_chat_id, this.montarResumoPedidoNovo(orderId, itens ?? [], pedido, endereco));
  }

  private montarResumoPedidoNovo(
    orderId: number,
    itens: any[],
    pedido: { total: number; payment_method: string; retirada_balcao: boolean } | null,
    endereco: string | null,
  ): string {
    const linhas = itens.map((item) => {
      const nome = item.combo_nome ?? item.products?.name ?? 'Item';
      const qtd = item.combo_quantidade ?? item.quantity ?? 1;
      const valorLinha = Number(item.unit_price ?? 0) * Number(item.quantity ?? 1);
      return `${qtd}x ${nome} — ${formatarMoeda(valorLinha)}`;
    });

    const partes = [`🔔 Novo pedido #${orderId} recebido!`];
    if (linhas.length) partes.push('', '🧾 Itens:', ...linhas);
    if (pedido?.total != null) partes.push('', `💰 Total: ${formatarMoeda(pedido.total)}`);
    if (pedido?.payment_method) partes.push(`💳 Pagamento: ${PAGAMENTO_LABEL[pedido.payment_method] ?? pedido.payment_method}`);
    partes.push(pedido?.retirada_balcao ? '🏠 Retirada no balcão' : `📍 Entrega: ${endereco ?? 'endereço não informado'}`);
    return partes.join('\n');
  }

  private montarMensagemEntregue(
    orderId: number,
    restaurante: { slug?: string | null; custom_domain?: string | null; instagram_url?: string | null; facebook_url?: string | null } | null,
  ): string {
    const link = restaurante?.custom_domain
      ? `https://${restaurante.custom_domain}`
      : restaurante?.slug
      ? `${MARKETPLACE_BASE_URL}/r/${restaurante.slug}`
      : null;

    const partes = [`🎉 Pedido #${orderId} entregue! Bom apetite.`, '', 'Obrigado por pedir com a gente! 🙏'];
    if (link) {
      partes.push('', `🔁 Repetir esse pedido: ${link}`, `📲 Compartilhe com quem também vai gostar: ${link}`);
    }
    const redes = [
      restaurante?.instagram_url ? `Instagram: ${restaurante.instagram_url}` : null,
      restaurante?.facebook_url ? `Facebook: ${restaurante.facebook_url}` : null,
    ].filter((r): r is string => !!r);
    if (redes.length) {
      partes.push('', '⭐ Siga nossas redes sociais:', ...redes);
    }
    return partes.join('\n');
  }
}

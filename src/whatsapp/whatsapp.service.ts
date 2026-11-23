import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsappClient } from './whatsapp.client';

const TOKEN_TTL_MS = 30 * 60 * 1000;

const formatarMoeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v ?? 0);

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly client: WhatsappClient | null;
  private readonly numeroBot: string;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
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
    const [{ data: cliente }, { data: itens }, { data: pedido }] = await Promise.all([
      this.supabase.client.from('customers').select('whatsapp_chat_id').eq('id', customerId).maybeSingle(),
      this.supabase.client
        .from('order_items')
        .select('quantity, unit_price, combo_nome, combo_quantidade, products(name)')
        .eq('order_id', orderId),
      this.supabase.client.from('orders').select('total').eq('id', orderId).maybeSingle(),
    ]);
    await this.enviarMensagem(cliente?.whatsapp_chat_id, this.montarResumoConfirmacao(orderId, itens ?? [], pedido?.total));
  }

  private montarResumoConfirmacao(orderId: number, itens: any[], total: number | null | undefined): string {
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
    if (total != null) {
      partes.push('', `💰 Total: ${formatarMoeda(total)}`);
    }
    return partes.join('\n');
  }

  async avisarPedidoEntregue(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const { data } = await this.supabase.client
      .from('customers')
      .select('whatsapp_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    await this.enviarMensagem(data?.whatsapp_chat_id, `🎉 Pedido #${orderId} entregue! Bom apetite.`);
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
  async avisarPedidoPronto(orderId: number) {
    const { data: interesses } = await this.supabase.client
      .from('pedido_interesses_motoboy')
      .select('motoboy_id')
      .eq('order_id', orderId);
    const motoboyIds = (interesses ?? []).map((i) => i.motoboy_id);
    if (!motoboyIds.length) return;

    const { data: motoboys } = await this.supabase.client
      .from('motoboys')
      .select('whatsapp_chat_id')
      .in('id', motoboyIds);

    await Promise.all(
      (motoboys ?? []).map((m) => this.enviarMensagem(m.whatsapp_chat_id, `🛵 Pedido #${orderId} está pronto pra retirada!`)),
    );
  }
}

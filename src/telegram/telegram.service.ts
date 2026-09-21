import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { TelegramClient } from './telegram.client';

const TOKEN_TTL_MS = 30 * 60 * 1000;

const formatarMoeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v ?? 0);

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly client: TelegramClient | null;
  private readonly botUsername: string;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {
    const token = config.get<string>('TELEGRAM_TOKEN');
    this.client = token ? new TelegramClient(token) : null;
    this.botUsername = config.get<string>('TELEGRAM_BOT_USERNAME') || '';
    if (!token) {
      this.logger.warn('TELEGRAM_TOKEN não configurada — notificações via Telegram vão ficar desligadas.');
    }
  }

  // Registro do webhook é idempotente do lado do Telegram — chamar de novo com a
  // mesma URL/secret não tem efeito colateral, então é seguro fazer isso a cada boot.
  async onModuleInit() {
    if (!this.client) return;
    const webhookUrl = this.config.get<string>('TELEGRAM_WEBHOOK_URL');
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!webhookUrl || !secret) {
      this.logger.warn('TELEGRAM_WEBHOOK_URL/TELEGRAM_WEBHOOK_SECRET não configurados — webhook do bot não foi registrado.');
      return;
    }
    try {
      await this.client.setWebhook(webhookUrl, secret);
    } catch (e: any) {
      this.logger.warn(`Falha ao registrar webhook do Telegram: ${e.message}`);
    }
  }

  // Efeito colateral best-effort — nunca deixa uma falha de envio quebrar o fluxo
  // principal (confirmação de pagamento, entrega, cozinha). Erro só vira log.
  private async enviarMensagem(chatId: number | null | undefined, texto: string): Promise<void> {
    if (!chatId || !this.client) return;
    try {
      await this.client.sendMessage(chatId, texto);
    } catch (e: any) {
      this.logger.warn(`Falha ao enviar mensagem Telegram (chat ${chatId}): ${e.message}`);
    }
  }

  private async gerarLink(tipo: 'cliente' | 'motoboy', entidadeId: number) {
    // Só pode existir um token válido por entidade — gerar de novo invalida
    // qualquer link anterior ainda não resgatado.
    await this.supabase.client.from('telegram_link_tokens').delete().eq('tipo', tipo).eq('entidade_id', entidadeId);

    const token = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    const { error } = await this.supabase.client
      .from('telegram_link_tokens')
      .insert({ tipo, entidade_id: entidadeId, token, expira_em: expiraEm });
    if (error) throw error;

    return { token, deep_link: `https://t.me/${this.botUsername}?start=${token}` };
  }

  gerarLinkCliente(customerId: number) {
    return this.gerarLink('cliente', customerId);
  }

  gerarLinkMotoboy(motoboyId: number) {
    return this.gerarLink('motoboy', motoboyId);
  }

  async statusCliente(customerId: number) {
    const { data } = await this.supabase.client
      .from('customers')
      .select('telegram_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    return { vinculado: !!data?.telegram_chat_id };
  }

  async statusMotoboy(motoboyId: number) {
    const { data } = await this.supabase.client
      .from('motoboys')
      .select('telegram_chat_id')
      .eq('id', motoboyId)
      .maybeSingle();
    return { vinculado: !!data?.telegram_chat_id };
  }

  // Chamado pelo webhook quando chega "/start <token>". Resgate apaga o token
  // (não só marca usado) — mesmo espírito do padrão do cozinha-portal.
  async redimirToken(token: string, chatId: number) {
    const { data } = await this.supabase.client
      .from('telegram_link_tokens')
      .select('tipo, entidade_id, expira_em')
      .eq('token', token)
      .maybeSingle();

    if (!data || new Date(data.expira_em) < new Date()) {
      await this.enviarMensagem(chatId, 'Esse link expirou. Gere um novo no app e tente de novo.');
      return;
    }

    const tabela = data.tipo === 'cliente' ? 'customers' : 'motoboys';
    await this.supabase.client.from(tabela).update({ telegram_chat_id: chatId }).eq('id', data.entidade_id);
    await this.supabase.client.from('telegram_link_tokens').delete().eq('token', token);

    await this.enviarMensagem(chatId, '✅ Telegram vinculado! Você vai receber as notificações do PediuVai por aqui.');
  }

  async avisarPedidoConfirmado(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const [{ data: cliente }, { data: itens }, { data: pedido }] = await Promise.all([
      this.supabase.client.from('customers').select('telegram_chat_id').eq('id', customerId).maybeSingle(),
      this.supabase.client
        .from('order_items')
        .select('quantity, unit_price, combo_nome, combo_quantidade, products(name)')
        .eq('order_id', orderId),
      this.supabase.client.from('orders').select('total').eq('id', orderId).maybeSingle(),
    ]);
    await this.enviarMensagem(cliente?.telegram_chat_id, this.montarResumoConfirmacao(orderId, itens ?? [], pedido?.total));
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
      .select('telegram_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    await this.enviarMensagem(data?.telegram_chat_id, `🎉 Pedido #${orderId} entregue! Bom apetite.`);
  }

  async avisarPedidoSaiuEntrega(orderId: number, customerId: number | null | undefined) {
    if (!customerId) return;
    const { data } = await this.supabase.client
      .from('customers')
      .select('telegram_chat_id')
      .eq('id', customerId)
      .maybeSingle();
    await this.enviarMensagem(data?.telegram_chat_id, `🛵 Pedido #${orderId} saiu para entrega!`);
  }

  // Só avisa quem já demonstrou interesse nesse pedido específico (pedido_interesses_motoboy)
  // — na hora que o pedido fica pronto ainda não existe motoboy_id atribuído, então não dá
  // pra mirar em "o" motoboy. Sem fallback de broadcast pra todo mundo (decisão de produto).
  async avisarPedidoPronto(orderId: number) {
    const { data: interesses } = await this.supabase.client
      .from('pedido_interesses_motoboy')
      .select('motoboy_id')
      .eq('order_id', orderId);
    const motoboyIds = (interesses ?? []).map((i) => i.motoboy_id);
    if (!motoboyIds.length) return;

    const { data: motoboys } = await this.supabase.client
      .from('motoboys')
      .select('telegram_chat_id')
      .in('id', motoboyIds);

    await Promise.all(
      (motoboys ?? []).map((m) => this.enviarMensagem(m.telegram_chat_id, `🛵 Pedido #${orderId} está pronto pra retirada!`)),
    );
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ComissaoService } from './comissao.service';
import { GeocodingService } from './geocoding.service';

const DOC_BUCKET = 'motoboy-documentos';
const SIGNED_URL_TTL = 60 * 10; // 10 min

@Injectable()
export class MotoboyService {
  constructor(
    private supabase: SupabaseService,
    private comissao: ComissaoService,
    private geocoding: GeocodingService,
  ) {}

  private async exigirAfiliacaoAceita(motoboyId: number, restaurantId: number) {
    const { data } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('id')
      .eq('motoboy_id', motoboyId)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aceito')
      .maybeSingle();
    if (!data) throw new ForbiddenException('Motoboy não está afiliado a este estabelecimento');
  }

  // Estabelecimento que optou por entregar por conta própria não deve aparecer
  // pra motoboys pegarem pedido sozinhos — o dono ainda pode atribuir manualmente
  // como exceção (não passa por aqui).
  private async exigirUsaMotoboy(restaurantId: number) {
    const { data } = await this.supabase.client
      .from('restaurants')
      .select('usa_motoboy')
      .eq('id', restaurantId)
      .maybeSingle();
    if (data && data.usa_motoboy === false) {
      throw new ForbiddenException('Este estabelecimento faz entregas por conta própria');
    }
  }

  private async signedUrl(path: string | null | undefined): Promise<string | null> {
    if (!path) return null;
    const { data } = await this.supabase.client.storage.from(DOC_BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
  }

  // ── Lado restaurante: gestão de afiliados ──────────────────────────

  async listar(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('motoboy:motoboys(id, name, phone, foto_perfil_url)')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aceito');
    if (error) throw error;

    const motoboys = await Promise.all(
      (data ?? []).map(async (row: any) => ({
        ...row.motoboy,
        foto_perfil_url: await this.signedUrl(row.motoboy?.foto_perfil_url),
      })),
    );
    return { motoboys };
  }

  async listarSolicitacoes(restaurantId: number, status: 'pendente' | 'aceito' | 'recusado' = 'pendente') {
    // Pra pendente precisamos da ficha completa (docs via signed URL); pra histórico
    // (aceito/recusado) só o básico, evita gerar signed URL à toa por linha.
    const campos = status === 'pendente'
      ? 'motoboy:motoboys(id, name, phone, email, foto_perfil_url, documento_frente_url, documento_verso_url, comprovante_endereco_url)'
      : 'motoboy:motoboys(id, name, phone, email)';

    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select(`id, solicitado_em, respondido_em, motivo_recusa, ${campos}`)
      .eq('restaurant_id', restaurantId)
      .eq('status', status)
      .order(status === 'pendente' ? 'solicitado_em' : 'respondido_em', { ascending: status === 'pendente' });
    if (error) throw error;

    if (status !== 'pendente') {
      return {
        solicitacoes: (data ?? []).map((row: any) => ({
          id: row.id,
          solicitado_em: row.solicitado_em,
          respondido_em: row.respondido_em,
          motivo_recusa: row.motivo_recusa,
          motoboy: row.motoboy,
        })),
      };
    }

    const solicitacoes = await Promise.all(
      (data ?? []).map(async (row: any) => ({
        id: row.id,
        solicitado_em: row.solicitado_em,
        motoboy: {
          ...row.motoboy,
          foto_perfil_url: await this.signedUrl(row.motoboy?.foto_perfil_url),
          documento_frente_url: await this.signedUrl(row.motoboy?.documento_frente_url),
          documento_verso_url: await this.signedUrl(row.motoboy?.documento_verso_url),
          comprovante_endereco_url: await this.signedUrl(row.motoboy?.comprovante_endereco_url),
        },
      })),
    );
    return { solicitacoes };
  }

  async contarSolicitacoesPendentes(restaurantId: number) {
    const { count, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente');
    if (error) throw error;
    return { count: count ?? 0 };
  }

  async aceitarSolicitacao(id: number, restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .update({ status: 'aceito', respondido_em: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Solicitação não encontrada ou já respondida');
    return data;
  }

  async recusarSolicitacao(id: number, restaurantId: number, motivo?: string) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .update({
        status: 'recusado',
        motivo_recusa: motivo ?? null,
        respondido_em: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pendente')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Solicitação não encontrada ou já respondida');
    return data;
  }

  // Restaurante muda de ideia sobre uma solicitação recusada — volta pra "pendente"
  // pra reavaliar (limpa motivo/data da recusa anterior).
  async revisarSolicitacao(id: number, restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .update({
        status: 'pendente',
        motivo_recusa: null,
        respondido_em: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'recusado')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Solicitação recusada não encontrada');
    return data;
  }

  async removerAfiliacao(motoboyId: number, restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .update({ status: 'removido', updated_at: new Date().toISOString() })
      .eq('motoboy_id', motoboyId)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'aceito')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Afiliação não encontrada');
    return { ok: true };
  }

  async atribuir(pedidoId: number, restaurantId: number, motoboyId: number) {
    await this.exigirAfiliacaoAceita(motoboyId, restaurantId);

    const { error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'out_for_delivery', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId);
    if (error) throw error;
    return { ok: true, status: 'out_for_delivery' };
  }

  // ── Lado motoboy: buscar/solicitar afiliação ───────────────────────

  async buscarEstabelecimentos(motoboyId: number, busca?: string) {
    let query = this.supabase.client
      .from('restaurants')
      .select('id, name, address, logo_url')
      .eq('bloqueado', false)
      .order('name')
      .limit(50);
    if (busca) query = query.ilike('name', `%${busca}%`);
    const { data: restaurantes, error } = await query;
    if (error) throw error;

    const ids = (restaurantes ?? []).map((r) => r.id);
    const { data: afiliacoes } = ids.length
      ? await this.supabase.client
          .from('motoboy_estabelecimentos')
          .select('restaurant_id, status')
          .eq('motoboy_id', motoboyId)
          .in('restaurant_id', ids)
      : { data: [] as any[] };
    const statusMap = Object.fromEntries((afiliacoes ?? []).map((a: any) => [a.restaurant_id, a.status]));

    return {
      estabelecimentos: (restaurantes ?? []).map((r) => ({ ...r, status_afiliacao: statusMap[r.id] ?? null })),
    };
  }

  async solicitarAfiliacao(motoboyId: number, restaurantId: number) {
    const { data: existente } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('id, status')
      .eq('motoboy_id', motoboyId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();

    if (existente) {
      if (existente.status === 'aceito') throw new ConflictException('Você já atende este estabelecimento');
      if (existente.status === 'pendente') throw new ConflictException('Solicitação já enviada, aguardando resposta');
      // recusado ou removido — reabre como pendente
      const { data, error } = await this.supabase.client
        .from('motoboy_estabelecimentos')
        .update({
          status: 'pendente',
          motivo_recusa: null,
          solicitado_em: new Date().toISOString(),
          respondido_em: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existente.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .insert({ motoboy_id: motoboyId, restaurant_id: restaurantId })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async minhasAfiliacoes(motoboyId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_estabelecimentos')
      .select('id, status, motivo_recusa, solicitado_em, respondido_em, restaurant:restaurants(id, name, address, logo_url)')
      .eq('motoboy_id', motoboyId)
      .neq('status', 'removido')
      .order('solicitado_em', { ascending: false });
    if (error) throw error;
    return { afiliacoes: data ?? [] };
  }

  // ── Motoboy portal: pedidos ─────────────────────────────────────────

  async meusPedidos(motoboyId: number) {
    const { data, error } = await this.supabase.client
      .from('orders')
      .select(
        'id, total, troco_para, status, payment_method, restaurant_id, created_at, updated_at, motoboy_lat, motoboy_lng, customer_id, delivery_notes, delivery_occurrence',
      )
      .eq('motoboy_id', motoboyId)
      .not('status', 'in', '("delivered","canceled")')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const restIds = [...new Set((data ?? []).map((p) => p.restaurant_id).filter(Boolean))];
    const { data: restaurantes } = restIds.length
      ? await this.supabase.client.from('restaurants').select('id, name, payment_config').in('id', restIds)
      : { data: [] as any[] };
    const restMap = Object.fromEntries(
      (restaurantes ?? []).map((r: any) => [r.id, { name: r.name, chave_pix: r.payment_config?.chave_pix ?? null }]),
    );

    const pedidos = await Promise.all(
      (data ?? []).map(async (p) => {
        const [{ data: c }, { data: itensRaw }] = await Promise.all([
          p.customer_id
            ? this.supabase.client
                .from('customers')
                .select('name, phone_e164, address_json')
                .eq('id', p.customer_id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          this.supabase.client
            .from('order_items')
            .select('id, quantity, unit_price, product_id')
            .eq('order_id', p.id),
        ]);

        let itens = itensRaw ?? [];
        if (itens.length > 0) {
          const prodIds = itens.map((i: any) => i.product_id);
          const { data: prods } = await this.supabase.client
            .from('products')
            .select('id, name')
            .in('id', prodIds);
          const prodMap = Object.fromEntries((prods ?? []).map((pr: any) => [pr.id, pr.name]));
          itens = itens.map((i: any) => ({ ...i, product_name: prodMap[i.product_id] ?? `Produto #${i.product_id}` }));
        }

        return { ...p, cliente: c, itens, restaurante: restMap[p.restaurant_id] ?? null };
      }),
    );
    return { pedidos };
  }

  async atualizarLocalizacao(pedidoId: number, motoboyId: number, lat: number, lng: number) {
    const { error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_lat: lat, motoboy_lng: lng, motoboy_location_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId);
    if (error) throw error;
    return { ok: true };
  }

  async confirmarEntrega(
    pedidoId: number,
    motoboyId: number,
    entregaPagamento?: { metodo: string; dinheiro?: number; pix?: number },
  ) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, total, frete_cobrado, customer_id')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const updatePayload: Record<string, any> = { status: 'delivered', updated_at: new Date().toISOString() };
    if (entregaPagamento) updatePayload.entrega_pagamento = entregaPagamento;

    const { error } = await this.supabase.client
      .from('orders')
      .update(updatePayload)
      .eq('id', pedidoId);
    if (error) throw error;

    // Registrar entrada(s) no caixa aberto
    if (entregaPagamento && pedido.restaurant_id) {
      const { data: caixa } = await this.supabase.client
        .from('caixas')
        .select('id, entradas')
        .eq('restaurant_id', pedido.restaurant_id)
        .eq('status', 'aberto')
        .eq('is_principal', true)
        .maybeSingle();

      if (caixa) {
        const entradas = (caixa.entradas ?? []) as any[];
        const novas: any[] = [];
        const agora = new Date().toISOString();

        if ((entregaPagamento.dinheiro ?? 0) > 0) {
          novas.push({
            descricao: `Entrega pedido #${pedidoId} — dinheiro`,
            valor: entregaPagamento.dinheiro,
            meio: 'dinheiro',
            criado_em: agora,
          });
        }
        if ((entregaPagamento.pix ?? 0) > 0) {
          novas.push({
            descricao: `Entrega pedido #${pedidoId} — PIX`,
            valor: entregaPagamento.pix,
            meio: 'pix',
            criado_em: agora,
          });
        }

        if (novas.length > 0) {
          await this.supabase.client
            .from('caixas')
            .update({ entradas: [...entradas, ...novas] })
            .eq('id', caixa.id);
        }
      }
    }

    // Calcula e registra a comissão do motoboy (idempotente — UNIQUE(pedido_id))
    await this.comissao.registrarComissaoEntrega(pedido, motoboyId);

    return { ok: true, pedido_id: pedidoId, status: 'delivered' };
  }

  // Dono do restaurante marca um pedido como entregue pela própria loja, sem motoboy.
  // Só permitido se não houver motoboy atribuído (evita marcar como entrega própria
  // um pedido que já está com um motoboy de verdade).
  async entregarProprio(
    pedidoId: number,
    restaurantId: number,
    entregaPagamento?: { metodo: string; dinheiro?: number; pix?: number },
  ) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, status, restaurant_id, motoboy_id, total')
      .eq('id', pedidoId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado neste restaurante');
    if (pedido.motoboy_id) throw new BadRequestException('Pedido já está atribuído a um motoboy');

    const updatePayload: Record<string, any> = {
      status: 'delivered',
      entrega_propria: true,
      updated_at: new Date().toISOString(),
    };
    if (entregaPagamento) updatePayload.entrega_pagamento = entregaPagamento;

    const { error } = await this.supabase.client.from('orders').update(updatePayload).eq('id', pedidoId);
    if (error) throw error;

    if (entregaPagamento) {
      const { data: caixa } = await this.supabase.client
        .from('caixas')
        .select('id, entradas')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'aberto')
        .eq('is_principal', true)
        .maybeSingle();

      if (caixa) {
        const entradas = (caixa.entradas ?? []) as any[];
        const novas: any[] = [];
        const agora = new Date().toISOString();

        if ((entregaPagamento.dinheiro ?? 0) > 0) {
          novas.push({
            descricao: `Entrega própria pedido #${pedidoId} — dinheiro`,
            valor: entregaPagamento.dinheiro,
            meio: 'dinheiro',
            criado_em: agora,
          });
        }
        if ((entregaPagamento.pix ?? 0) > 0) {
          novas.push({
            descricao: `Entrega própria pedido #${pedidoId} — PIX`,
            valor: entregaPagamento.pix,
            meio: 'pix',
            criado_em: agora,
          });
        }

        if (novas.length > 0) {
          await this.supabase.client.from('caixas').update({ entradas: [...entradas, ...novas] }).eq('id', caixa.id);
        }
      }
    }

    return { ok: true, pedido_id: pedidoId, status: 'delivered', entrega_propria: true };
  }

  async registrarOcorrencia(
    pedidoId: number,
    motoboyId: number,
    tipo: 'pendente' | 'cancelada',
    motivo: string,
  ) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, status')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const update: Record<string, any> = {
      delivery_notes: motivo.trim(),
      delivery_occurrence: tipo,
      updated_at: new Date().toISOString(),
    };
    if (tipo === 'cancelada') update.status = 'canceled';

    const { error } = await this.supabase.client
      .from('orders')
      .update(update)
      .eq('id', pedidoId);
    if (error) throw error;

    return { ok: true, pedido_id: pedidoId, tipo, status: update.status ?? pedido.status };
  }

  async pedidosDisponiveis(motoboyId: number, restaurantId: number) {
    await this.exigirAfiliacaoAceita(motoboyId, restaurantId);
    await this.exigirUsaMotoboy(restaurantId);

    const { data, error } = await this.supabase.client
      .from('orders')
      .select('id, total, status, payment_method, created_at, customer_id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'ready')
      .is('motoboy_id', null)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const pedidos = await Promise.all(
      (data ?? []).map(async (p) => {
        const { data: c } = p.customer_id
          ? await this.supabase.client
              .from('customers')
              .select('name, phone_e164, address_json')
              .eq('id', p.customer_id)
              .maybeSingle()
          : { data: null };
        const { data: itensRaw } = await this.supabase.client
          .from('order_items')
          .select('id, quantity, unit_price, product_id')
          .eq('order_id', p.id);
        return { ...p, cliente: c, itens: itensRaw ?? [] };
      }),
    );
    return { pedidos };
  }

  async pegarPedido(pedidoId: number, motoboyId: number) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, restaurant_id')
      .eq('id', pedidoId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    await this.exigirAfiliacaoAceita(motoboyId, pedido.restaurant_id);
    await this.exigirUsaMotoboy(pedido.restaurant_id);

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'motoboy_collecting', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', pedido.restaurant_id)
      .eq('status', 'ready')
      .is('motoboy_id', null)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new ConflictException('Pedido já foi pego por outro motoboy ou não está disponível');
    }
    return { ok: true, pedido_id: pedidoId, status: 'motoboy_collecting' };
  }

  async reivindicarPedido(pedidoId: number, motoboyId: number) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, restaurant_id')
      .eq('id', pedidoId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    await this.exigirAfiliacaoAceita(motoboyId, pedido.restaurant_id);
    await this.exigirUsaMotoboy(pedido.restaurant_id);

    const { data, error } = await this.supabase.client
      .from('orders')
      .update({ motoboy_id: motoboyId, status: 'motoboy_collecting', updated_at: new Date().toISOString() })
      .eq('id', pedidoId)
      .eq('restaurant_id', pedido.restaurant_id)
      .in('status', ['ready', 'preparing', 'confirmed'])
      .is('motoboy_id', null)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new ConflictException('Pedido não encontrado, já foi atribuído ou não está disponível');
    }
    return { ok: true, pedido_id: pedidoId, status: 'motoboy_collecting' };
  }

  async confirmarColeta(pedidoId: number, motoboyId: number, barcode: string) {
    const expected = String(pedidoId).padStart(8, '0');
    const scanned = barcode.replace(/\D/g, '').padStart(8, '0');
    if (scanned !== expected) {
      throw new BadRequestException('Código de barras não confere com este pedido');
    }

    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id, total, troco_para, payment_method, restaurant_id')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .eq('status', 'motoboy_collecting')
      .maybeSingle();
    if (!pedido) throw new ConflictException('Pedido não está aguardando coleta ou não pertence a você');

    const { error } = await this.supabase.client
      .from('orders')
      .update({ status: 'out_for_delivery', updated_at: new Date().toISOString() })
      .eq('id', pedidoId);
    if (error) throw error;

    const trocoValor = pedido.payment_method === 'cash' && pedido.troco_para > pedido.total
      ? Number(pedido.troco_para) - Number(pedido.total)
      : 0;
    if (trocoValor > 0) {
      const { data: caixa } = await this.supabase.client
        .from('caixas')
        .select('id, saidas')
        .eq('restaurant_id', pedido.restaurant_id)
        .eq('status', 'aberto')
        .eq('is_principal', true)
        .maybeSingle();
      if (caixa) {
        const saidas = (caixa.saidas ?? []) as any[];
        const novaSaida = {
          descricao: `Troco pedido #${pedidoId}`,
          valor: trocoValor,
          meio: 'dinheiro',
          criado_em: new Date().toISOString(),
        };
        await this.supabase.client
          .from('caixas')
          .update({ saidas: [...saidas, novaSaida] })
          .eq('id', caixa.id);
      }
    }

    return { ok: true, pedido_id: pedidoId, status: 'out_for_delivery', troco: trocoValor };
  }

  async uploadComprovante(pedidoId: number, motoboyId: number, base64: string) {
    const { data: pedido } = await this.supabase.client
      .from('orders')
      .select('id')
      .eq('id', pedidoId)
      .eq('motoboy_id', motoboyId)
      .maybeSingle();
    if (!pedido) throw new NotFoundException('Pedido não encontrado ou não atribuído a você');

    const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
    const mimeType = matches ? matches[1] : 'image/jpeg';
    const raw = matches ? matches[2] : base64;
    const buffer = Buffer.from(raw, 'base64');
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const path = `pedido-${pedidoId}-${Date.now()}.${ext}`;

    const { error: uploadError } = await this.supabase.client.storage
      .from('comprovantes-pix')
      .upload(path, buffer, { contentType: mimeType, upsert: true });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = this.supabase.client.storage
      .from('comprovantes-pix')
      .getPublicUrl(path);

    await this.supabase.client
      .from('orders')
      .update({ comprovante_pix_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', pedidoId);

    return { url: publicUrl };
  }

  async infoMotoboy(motoboyId: number) {
    const { data: mb } = await this.supabase.client
      .from('motoboys')
      .select('id, name, phone, email, foto_perfil_url, precisa_completar_cadastro')
      .eq('id', motoboyId)
      .maybeSingle();
    if (!mb) return null;

    const { afiliacoes } = await this.minhasAfiliacoes(motoboyId);

    return {
      ...mb,
      foto_perfil_url: await this.signedUrl(mb.foto_perfil_url),
      estabelecimentos: afiliacoes.filter((a: any) => a.status === 'aceito').map((a: any) => a.restaurant),
    };
  }

  // ── Ganhos / comissões ───────────────────────────────────────────────

  async ganhosResumo(motoboyId: number) {
    const { data, error } = await this.supabase.client
      .from('motoboy_comissoes')
      .select('restaurant_id, comissao_valor, restaurant:restaurants(name)')
      .eq('motoboy_id', motoboyId);
    if (error) throw error;

    const porRestaurante = new Map<number, { restaurant_id: number; nome: string; total: number; entregas: number }>();
    for (const row of data ?? []) {
      const atual = porRestaurante.get(row.restaurant_id) ?? {
        restaurant_id: row.restaurant_id,
        nome: (row as any).restaurant?.name ?? `Estabelecimento #${row.restaurant_id}`,
        total: 0,
        entregas: 0,
      };
      atual.total += Number(row.comissao_valor);
      atual.entregas += 1;
      porRestaurante.set(row.restaurant_id, atual);
    }

    const resumo = [...porRestaurante.values()].sort((a, b) => b.total - a.total);
    const totalGeral = resumo.reduce((acc, r) => acc + r.total, 0);
    return { resumo, total_geral: totalGeral };
  }

  async ganhosHistorico(motoboyId: number, restaurantId?: number) {
    let query = this.supabase.client
      .from('motoboy_comissoes')
      .select('id, restaurant_id, pedido_id, tipo, distancia_km, frete_repassado, valor_base, comissao_valor, status, criado_em, restaurant:restaurants(name)')
      .eq('motoboy_id', motoboyId)
      .order('criado_em', { ascending: false })
      .limit(100);
    if (restaurantId) query = query.eq('restaurant_id', restaurantId);

    const { data, error } = await query;
    if (error) throw error;
    return { historico: data ?? [] };
  }
}

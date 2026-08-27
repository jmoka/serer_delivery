import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from './geocoding.service';
import { Coordenadas, haversineKm } from '../common/geo.util';

interface PedidoParaComissao {
  id: number;
  restaurant_id: number;
  total: number;
  frete_cobrado: number;
  frete_excedente_cobrado?: number | null;
  distancia_entrega_km?: number | null;
  customer_id: number | null;
}

@Injectable()
export class ComissaoService {
  private readonly logger = new Logger(ComissaoService.name);

  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
  ) {}

  // Idempotente via UNIQUE(pedido_id) — chamado sempre que um pedido é marcado como entregue.
  async registrarComissaoEntrega(pedido: PedidoParaComissao, motoboyId: number) {
    const { data: existente } = await this.supabase.client
      .from('motoboy_comissoes')
      .select('id')
      .eq('pedido_id', pedido.id)
      .maybeSingle();
    if (existente) return existente;

    const { data: restaurant } = await this.supabase.client
      .from('restaurants')
      .select(
        'motoboy_comissao_tipo, motoboy_comissao_valor_fixo, motoboy_comissao_percentual, motoboy_comissao_valor_km, motoboy_comissao_km_fallback, lat, lng',
      )
      .eq('id', pedido.restaurant_id)
      .maybeSingle();
    if (!restaurant) return null;

    // O motoboy sempre recebe o frete cobrado do cliente, incluindo o excedente de
    // distância (ele que roda o km a mais) — o tipo configurado (fixo/percentual/km)
    // é um ADICIONAL somado em cima disso, não substituto.
    const freteExcedenteRepassado = Number(pedido.frete_excedente_cobrado ?? 0);
    const freteRepassado = Number(pedido.frete_cobrado ?? 0) + freteExcedenteRepassado;
    let tipo = restaurant.motoboy_comissao_tipo as string;
    let adicional = 0;
    // Já vem calculada do checkout (excedente de km) quando existir — evita geocodificar
    // de novo só pra exibir no histórico do motoboy.
    let distanciaKm: number | null = pedido.distancia_entrega_km != null ? Number(pedido.distancia_entrega_km) : null;
    let valorPorKm: number | null = null;
    let percentual: number | null = null;
    let valorBase = 0;

    if (tipo === 'fixo') {
      valorBase = Number(restaurant.motoboy_comissao_valor_fixo);
      adicional = valorBase;
    } else if (tipo === 'percentual') {
      percentual = Number(restaurant.motoboy_comissao_percentual);
      valorBase = freteRepassado;
      adicional = freteRepassado * (percentual / 100);
    } else if (tipo === 'km') {
      const distancia = await this.calcularDistanciaPedido(pedido.customer_id, restaurant.lat, restaurant.lng);
      if (distancia !== null) {
        distanciaKm = parseFloat(distancia.toFixed(2));
        valorPorKm = Number(restaurant.motoboy_comissao_valor_km);
        adicional = distancia * valorPorKm;
      } else {
        tipo = 'km_fallback';
        valorBase = Number(restaurant.motoboy_comissao_km_fallback);
        adicional = valorBase;
      }
    }

    const comissaoValor = freteRepassado + adicional;

    const { data, error } = await this.supabase.client
      .from('motoboy_comissoes')
      .insert({
        motoboy_id: motoboyId,
        restaurant_id: pedido.restaurant_id,
        pedido_id: pedido.id,
        tipo,
        valor_base: valorBase,
        frete_repassado: parseFloat(freteRepassado.toFixed(2)),
        frete_excedente_repassado: parseFloat(freteExcedenteRepassado.toFixed(2)),
        percentual,
        distancia_km: distanciaKm,
        valor_por_km: valorPorKm,
        comissao_valor: parseFloat(comissaoValor.toFixed(2)),
      })
      .select()
      .single();

    if (error) {
      // Corrida (dupla chamada) esbarra no UNIQUE(pedido_id) — não é um erro fatal aqui.
      this.logger.warn(`Falha ao registrar comissão do pedido ${pedido.id}: ${error.message}`);
      return null;
    }
    return data;
  }

  // Público: reaproveitado por PedidosService pra calcular excedente de km no checkout.
  async calcularDistanciaPedido(
    customerId: number | null,
    restLat: number | null,
    restLng: number | null,
  ): Promise<number | null> {
    if (!customerId || restLat == null || restLng == null) return null;

    const { data: customer } = await this.supabase.client
      .from('customers')
      .select('lat, lng, address_json')
      .eq('id', customerId)
      .maybeSingle();
    if (!customer) return null;

    let { lat, lng } = customer;
    if (lat == null || lng == null) {
      // Best-effort: geocodifica agora caso não tenha sido feito no checkout.
      const coords = await this.geocoding.geocodeEnderecoBr(customer.address_json);
      if (!coords) return null;

      lat = coords.lat;
      lng = coords.lng;
      const hash = crypto.createHash('md5').update(JSON.stringify(customer.address_json ?? {})).digest('hex');
      await this.supabase.client
        .from('customers')
        .update({ lat, lng, address_geocode_hash: hash, address_geocoded_at: new Date().toISOString() })
        .eq('id', customerId);
    }

    return haversineKm({ lat: restLat, lng: restLng }, { lat, lng });
  }
}

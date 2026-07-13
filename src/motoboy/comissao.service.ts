import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from './geocoding.service';

interface Coordenadas {
  lat: number;
  lng: number;
}

function haversineKm(a: Coordenadas, b: Coordenadas): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

interface PedidoParaComissao {
  id: number;
  restaurant_id: number;
  total: number;
  frete_cobrado: number;
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

    const freteCobrado = Number(pedido.frete_cobrado ?? 0);
    let tipo = restaurant.motoboy_comissao_tipo as string;
    let comissaoValor = 0;
    let distanciaKm: number | null = null;
    let valorPorKm: number | null = null;
    let percentual: number | null = null;
    let valorBase = 0;

    if (tipo === 'fixo') {
      valorBase = Number(restaurant.motoboy_comissao_valor_fixo);
      comissaoValor = valorBase;
    } else if (tipo === 'percentual') {
      percentual = Number(restaurant.motoboy_comissao_percentual);
      valorBase = freteCobrado;
      comissaoValor = freteCobrado * (percentual / 100);
    } else if (tipo === 'km') {
      const distancia = await this.calcularDistanciaPedido(pedido.customer_id, restaurant.lat, restaurant.lng);
      if (distancia !== null) {
        distanciaKm = parseFloat(distancia.toFixed(2));
        valorPorKm = Number(restaurant.motoboy_comissao_valor_km);
        comissaoValor = distancia * valorPorKm;
      } else {
        tipo = 'km_fallback';
        valorBase = Number(restaurant.motoboy_comissao_km_fallback);
        comissaoValor = valorBase;
      }
    }

    const { data, error } = await this.supabase.client
      .from('motoboy_comissoes')
      .insert({
        motoboy_id: motoboyId,
        restaurant_id: pedido.restaurant_id,
        pedido_id: pedido.id,
        tipo,
        valor_base: valorBase,
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

  private async calcularDistanciaPedido(
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
      const enderecoTexto = this.formatarEndereco(customer.address_json);
      const coords = await this.geocoding.geocodeEndereco(enderecoTexto);
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

  private formatarEndereco(addressJson: any): string {
    if (!addressJson) return '';
    const { logradouro, numero, bairro, cidade, estado, cep } = addressJson;
    return [logradouro, numero, bairro, cidade, estado, cep].filter(Boolean).join(', ');
  }
}

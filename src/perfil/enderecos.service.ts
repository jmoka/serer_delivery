import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from '../motoboy/geocoding.service';
import { haversineKm } from '../common/geo.util';

const SELECT_ENDERECO = 'id, apelido, address_json, lat, lng, address_geocode_hash, padrao, lat_ajustado_manualmente';
const SELECT_PERFIL = 'id, name, email, phone_e164, address_json, foto_perfil_url, cpf_cnpj';

// Distância acima da qual o pino salvo é considerado divergente do texto do
// endereço (cenário 2 de "endereço desatualizado"). Mais rígido que
// DISTANCIA_MAXIMA_PLAUSIVEL_KM de pedidos.service.ts, que mede plausibilidade
// da distância até o RESTAURANTE — coisa diferente da precisão do geocode aqui.
const DISTANCIA_DIVERGENCIA_KM = 1.5;

@Injectable()
export class EnderecosService {
  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
  ) {}

  private hashEndereco(addressJson: Record<string, any>) {
    return crypto.createHash('md5').update(JSON.stringify(addressJson)).digest('hex');
  }

  private validarAddressJson(addressJson: Record<string, any>) {
    const { logradouro, numero } = addressJson ?? {};
    if (!logradouro?.toString().trim() || !numero?.toString().trim()) {
      throw new BadRequestException('Endereço precisa de logradouro e número');
    }
  }

  private async getCustomerId(userId: string): Promise<number> {
    const { data } = await this.supabase.client
      .from('customers')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Perfil não encontrado.');
    return data.id;
  }

  // Clientes que já tinham endereço salvo antes dessa feature (em
  // customers.address_json) ainda não têm linha em customer_addresses —
  // materializa uma na primeira listagem, copiando o que já está salvo (inclui
  // lat/lng nulos se o cliente nunca ajustou pino — dispara o cenário 1 sozinho).
  private async backfillSeNecessario(customerId: number) {
    const { data: existentes } = await this.supabase.client
      .from('customer_addresses')
      .select('id')
      .eq('customer_id', customerId)
      .limit(1);
    if (existentes?.length) return;

    const { data: customer } = await this.supabase.client
      .from('customers')
      .select('address_json, lat, lng, address_geocode_hash, address_geocoded_at, lat_ajustado_manualmente')
      .eq('id', customerId)
      .maybeSingle();
    if (!customer?.address_json) return;

    await this.supabase.client.from('customer_addresses').insert({
      customer_id: customerId,
      address_json: customer.address_json,
      lat: customer.lat,
      lng: customer.lng,
      address_geocode_hash: customer.address_geocode_hash,
      address_geocoded_at: customer.address_geocoded_at,
      lat_ajustado_manualmente: customer.lat_ajustado_manualmente ?? false,
      padrao: true,
    });
  }

  async listar(userId: string) {
    const customerId = await this.getCustomerId(userId);
    await this.backfillSeNecessario(customerId);

    const { data } = await this.supabase.client
      .from('customer_addresses')
      .select(SELECT_ENDERECO)
      .eq('customer_id', customerId)
      .order('padrao', { ascending: false })
      .order('id', { ascending: false });

    // Flags baratas (sem chamar geocoding) — a divergência geográfica de
    // verdade (cenário 2) só é checada sob demanda em verificar().
    return (data ?? []).map((e) => ({
      ...e,
      semPino: e.lat == null || e.lng == null,
      textoDesatualizado: this.hashEndereco(e.address_json) !== e.address_geocode_hash,
    }));
  }

  async criar(
    userId: string,
    body: { apelido?: string; address_json: Record<string, any>; lat?: number; lng?: number; definirComoAtivo?: boolean },
  ) {
    this.validarAddressJson(body.address_json);
    const customerId = await this.getCustomerId(userId);

    const pinoManual = body.lat != null && body.lng != null;
    let lat: number | null = body.lat ?? null;
    let lng: number | null = body.lng ?? null;
    let hash: string | null = null;

    if (pinoManual) {
      hash = this.hashEndereco(body.address_json);
    } else {
      const resultado = await this.geocoding.geocodificarSeNecessario(body.address_json, null);
      if (resultado) {
        lat = resultado.lat;
        lng = resultado.lng;
        hash = resultado.hash;
      }
    }

    const { data, error } = await this.supabase.client
      .from('customer_addresses')
      .insert({
        customer_id: customerId,
        apelido: body.apelido ?? null,
        address_json: body.address_json,
        lat,
        lng,
        address_geocode_hash: hash,
        address_geocoded_at: lat != null ? new Date().toISOString() : null,
        lat_ajustado_manualmente: pinoManual,
      })
      .select(SELECT_ENDERECO)
      .single();
    if (error) throw error;

    if (body.definirComoAtivo !== false) {
      return this.selecionar(userId, data.id);
    }
    return data;
  }

  async editar(
    userId: string,
    id: number,
    body: { apelido?: string; address_json?: Record<string, any>; lat?: number; lng?: number },
  ) {
    const customerId = await this.getCustomerId(userId);
    const { data: existing } = await this.supabase.client
      .from('customer_addresses')
      .select('id, address_json, address_geocode_hash, lat_ajustado_manualmente, padrao')
      .eq('id', id)
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!existing) throw new NotFoundException('Endereço não encontrado.');

    if (body.address_json) this.validarAddressJson(body.address_json);

    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.apelido !== undefined) update.apelido = body.apelido;
    if (body.address_json) update.address_json = body.address_json;

    const addressJson = body.address_json ?? existing.address_json;
    const pinoManual = body.lat != null && body.lng != null;

    if (pinoManual) {
      update.lat = body.lat;
      update.lng = body.lng;
      update.lat_ajustado_manualmente = true;
      update.address_geocode_hash = this.hashEndereco(addressJson);
      update.address_geocoded_at = new Date().toISOString();
    } else if (body.address_json && !existing.lat_ajustado_manualmente) {
      const resultado = await this.geocoding.geocodificarSeNecessario(body.address_json, existing.address_geocode_hash);
      if (resultado) {
        update.lat = resultado.lat;
        update.lng = resultado.lng;
        update.address_geocoded_at = new Date().toISOString();
        if (resultado.hash) update.address_geocode_hash = resultado.hash;
      }
    }

    const { data, error } = await this.supabase.client
      .from('customer_addresses')
      .update(update)
      .eq('id', id)
      .select(SELECT_ENDERECO)
      .single();
    if (error) throw error;

    // Se esse endereço é o ativo, propaga a mudança pro endereço ativo em customers.
    if (existing.padrao) {
      await this.selecionar(userId, id, pinoManual ? { lat: body.lat, lng: body.lng } : undefined);
    }
    return data;
  }

  async excluir(userId: string, id: number) {
    const customerId = await this.getCustomerId(userId);
    const { data: existing } = await this.supabase.client
      .from('customer_addresses')
      .select('id, padrao')
      .eq('id', id)
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!existing) throw new NotFoundException('Endereço não encontrado.');

    await this.supabase.client.from('customer_addresses').delete().eq('id', id);

    // Endereço excluído era o ativo — promove outro (se existir) a padrão.
    if (existing.padrao) {
      const { data: proximo } = await this.supabase.client
        .from('customer_addresses')
        .select('id')
        .eq('customer_id', customerId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (proximo) await this.selecionar(userId, proximo.id);
    }
    return { id };
  }

  // Cenário 2 de desatualização: pino salvo diverge do texto do endereço. Só
  // roda sob demanda (cliente abrindo um endereço salvo pra confirmar antes de
  // usar) — nunca em listar(), pra não estourar o rate limit do Nominatim
  // (~1 req/s) varrendo a lista inteira a cada load da tela.
  async verificar(userId: string, id: number) {
    const customerId = await this.getCustomerId(userId);
    const { data: endereco } = await this.supabase.client
      .from('customer_addresses')
      .select('id, address_json, lat, lng')
      .eq('id', id)
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!endereco) throw new NotFoundException('Endereço não encontrado.');

    const coords = await this.geocoding.geocodeEnderecoBr(endereco.address_json);
    if (!coords) return { divergente: false, latSugerido: null, lngSugerido: null, distanciaKm: null };

    if (endereco.lat == null || endereco.lng == null) {
      return { divergente: true, latSugerido: coords.lat, lngSugerido: coords.lng, distanciaKm: null };
    }

    const distanciaKm = parseFloat(haversineKm({ lat: endereco.lat, lng: endereco.lng }, coords).toFixed(2));
    return { divergente: distanciaKm > DISTANCIA_DIVERGENCIA_KM, latSugerido: coords.lat, lngSugerido: coords.lng, distanciaKm };
  }

  // Copia o endereço escolhido pra customers (endereço "ativo"), a mesma tabela
  // que estimativa de frete, criação de pedido e impressão já leem sem
  // nenhuma mudança — é o que faz o resto do checkout continuar funcionando.
  async selecionar(userId: string, id: number, coordsAjustadas?: { lat?: number; lng?: number }) {
    const customerId = await this.getCustomerId(userId);
    const { data: endereco } = await this.supabase.client
      .from('customer_addresses')
      .select('id, address_json, lat, lng, address_geocode_hash, lat_ajustado_manualmente')
      .eq('id', id)
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!endereco) throw new NotFoundException('Endereço não encontrado.');

    const pinoAjustadoAgora = coordsAjustadas?.lat != null && coordsAjustadas?.lng != null;
    const lat = pinoAjustadoAgora ? coordsAjustadas!.lat! : endereco.lat;
    const lng = pinoAjustadoAgora ? coordsAjustadas!.lng! : endereco.lng;

    const updateCustomer: Record<string, any> = {
      address_json: endereco.address_json,
      lat,
      lng,
      address_geocode_hash: endereco.address_geocode_hash,
      lat_ajustado_manualmente: pinoAjustadoAgora || endereco.lat_ajustado_manualmente,
      updated_at: new Date().toISOString(),
    };
    if (lat != null) updateCustomer.address_geocoded_at = new Date().toISOString();

    const { data: perfil, error } = await this.supabase.client
      .from('customers')
      .update(updateCustomer)
      .eq('id', customerId)
      .select(SELECT_PERFIL)
      .single();
    if (error) throw error;

    await this.supabase.client.from('customer_addresses').update({ padrao: false }).eq('customer_id', customerId).neq('id', id);
    const updateEndereco: Record<string, any> = { padrao: true, updated_at: new Date().toISOString() };
    if (pinoAjustadoAgora) {
      updateEndereco.lat = lat;
      updateEndereco.lng = lng;
      updateEndereco.lat_ajustado_manualmente = true;
    }
    await this.supabase.client.from('customer_addresses').update(updateEndereco).eq('id', id);

    return perfil;
  }
}

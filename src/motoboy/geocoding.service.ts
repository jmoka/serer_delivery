import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface Coordenadas {
  lat: number;
  lng: number;
}

export interface ResultadoGeocodificacao {
  lat: number | null;
  lng: number | null;
  // null quando a geocodificação falhou — o chamador NÃO deve persistir esse hash
  // (deixa o hash salvo desatualizado de propósito, pra tentar de novo no próximo
  // save mesmo com o endereço idêntico, em vez de "travar" num resultado nulo).
  hash: string | null;
}

// Nominatim (OpenStreetMap) é gratuito mas rate-limited (~1 req/s) — throttle simples em memória.
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private ultimaChamada = 0;
  private readonly intervaloMinMs = 1100;

  constructor(private config: ConfigService) {}

  private async aguardarRateLimit() {
    const agora = Date.now();
    const espera = this.ultimaChamada + this.intervaloMinMs - agora;
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    this.ultimaChamada = Date.now();
  }

  async geocodeEndereco(texto: string): Promise<Coordenadas | null> {
    if (!texto?.trim()) return null;

    try {
      await this.aguardarRateLimit();

      const userAgent = this.config.get('NOMINATIM_USER_AGENT') ?? 'DeliveryHub/1.0';
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(texto)}&format=json&limit=1`;
      const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
      if (!res.ok) return null;

      const results = (await res.json()) as Array<{ lat: string; lon: string }>;
      if (!results?.length) return null;

      return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
    } catch (e) {
      this.logger.warn(`Falha ao geocodificar "${texto}": ${(e as Error).message}`);
      return null;
    }
  }

  // Endereço brasileiro completo (rua + número + bairro + CEP) costuma dar ZERO
  // resultado no Nominatim — numeração residencial e nomes de bairro com variações
  // (ex: "Vila (Mosqueiro)") raramente batem com o dado do OpenStreetMap. Tenta do
  // mais específico pro mais genérico, e usa o primeiro que encontrar algo — melhor
  // aproximar pela rua do que não geocodificar nada.
  private construirQueriesBr(addressJson: Record<string, string>): string[] {
    const { logradouro, numero, bairro, cidade, estado, cep } = addressJson;
    const candidatos = [
      [logradouro, numero, bairro, cidade, estado, cep],
      [logradouro, numero, cidade, estado],
      [logradouro, bairro, cidade, estado],
      [logradouro, cidade, estado],
    ].map((partes) => partes.filter(Boolean).join(', '));

    return [...new Set(candidatos.filter(Boolean))];
  }

  async geocodeEnderecoBr(addressJson: Record<string, string> | null | undefined): Promise<Coordenadas | null> {
    if (!addressJson) return null;
    for (const texto of this.construirQueriesBr(addressJson)) {
      const coords = await this.geocodeEndereco(texto);
      if (coords) return coords;
    }
    return null;
  }

  // Compartilhado entre PedidosService (geocodifica ao criar pedido, se comissão do
  // motoboy for por km) e PerfilService (geocodifica ao salvar o perfil do cliente).
  // Hash do address_json evita regeocodificar um endereço que não mudou. Retorna null
  // quando não há endereço ou o hash bate com o já salvo (nada a atualizar).
  async geocodificarSeNecessario(
    addressJson: Record<string, string> | null | undefined,
    hashAtual: string | null | undefined,
  ): Promise<ResultadoGeocodificacao | null> {
    if (!addressJson) return null;

    const hash = crypto.createHash('md5').update(JSON.stringify(addressJson)).digest('hex');
    if (hash === hashAtual) return null;

    const coords = await this.geocodeEnderecoBr(addressJson);

    return { lat: coords?.lat ?? null, lng: coords?.lng ?? null, hash: coords ? hash : null };
  }
}

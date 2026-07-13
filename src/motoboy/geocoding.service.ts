import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface Coordenadas {
  lat: number;
  lng: number;
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
}

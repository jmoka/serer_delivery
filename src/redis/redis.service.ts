import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis | null;

  constructor(private config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL não configurada — cache desativado, catálogo segue direto no Supabase.');
      this.client = null;
      return;
    }
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => 1000,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis indisponível: ${err.message}`));
  }

  // Cache é best-effort: sem REDIS_URL ou com Redis fora do ar, sempre cai pro caminho normal sem cache.
  async getJSON<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`Falha ao ler cache ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Falha ao gravar cache ${key}: ${(err as Error).message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private config: ConfigService) {
    this.client = new Redis(this.config.getOrThrow('REDIS_URL'), {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => 1000,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis indisponível: ${err.message}`));
  }

  // Cache é best-effort: qualquer falha (Redis fora do ar, etc) cai pro caminho normal sem cache.
  async getJSON<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`Falha ao ler cache ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Falha ao gravar cache ${key}: ${(err as Error).message}`);
    }
  }
}

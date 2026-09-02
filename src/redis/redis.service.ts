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

  // Variantes "strict" (fail-closed), pro desafio de 2FA — diferente do cache
  // acima (best-effort, ok pular se Redis cair), aqui o Redis indisponível
  // PRECISA bloquear a operação, nunca deixar o login pular o segundo fator
  // silenciosamente. Lançam erro em vez de engolir a falha.
  async setJSONStrict(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) throw new Error('Redis indisponível — tente novamente em instantes.');
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  // Leitura não-destrutiva — usada pro desafio de 2FA continuar disponível
  // pra novas tentativas até acertar o código ou estourar o limite/expirar.
  async getJSONStrict<T>(key: string): Promise<T | null> {
    if (!this.client) throw new Error('Redis indisponível — tente novamente em instantes.');
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async del(key: string): Promise<void> {
    if (!this.client) throw new Error('Redis indisponível — tente novamente em instantes.');
    await this.client.del(key);
  }

  // Contador de tentativas com TTL (ex. tentativas erradas de código 2FA por
  // challenge_id) — incrementa e devolve o total atual; primeira chamada seta
  // o TTL, chamadas seguintes só incrementam.
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    if (!this.client) throw new Error('Redis indisponível — tente novamente em instantes.');
    const total = await this.client.incr(key);
    if (total === 1) await this.client.expire(key, ttlSeconds);
    return total;
  }
}

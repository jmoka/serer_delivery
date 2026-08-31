import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface ConsultaCnpj {
  ehMei: boolean;
  cnae: string | null;
}

const CACHE_TTL_SEGUNDOS = 60 * 60 * 24; // 24h — reduz chamadas repetidas à API pública pro mesmo CNPJ.

// Consulta pública de CNPJ (BrasilAPI, sem chave) pra validar se o entregador
// é MEI. Falha/timeout NUNCA deve derrubar o cadastro do motoboy — quem chama
// trata o retorno null como "revisão manual", mesmo contrato do GeocodingService.
@Injectable()
export class CnpjService {
  private readonly logger = new Logger(CnpjService.name);

  constructor(private redis: RedisService) {}

  async consultarCnpj(cnpj: string): Promise<ConsultaCnpj | null> {
    if (!cnpj || cnpj.length !== 14) return null;

    const cacheKey = `cnpj:${cnpj}`;
    const cached = await this.redis.getJSON<ConsultaCnpj>(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (!res.ok) return null;

      const data = (await res.json()) as {
        descricao_situacao_cadastral?: string;
        opcao_pelo_simei?: boolean;
        cnae_fiscal?: number | string;
      };

      const resultado: ConsultaCnpj = {
        ehMei: data.opcao_pelo_simei === true && data.descricao_situacao_cadastral === 'ATIVA',
        cnae: data.cnae_fiscal != null ? String(data.cnae_fiscal) : null,
      };

      await this.redis.setJSON(cacheKey, resultado, CACHE_TTL_SEGUNDOS);
      return resultado;
    } catch (e) {
      this.logger.warn(`Falha ao consultar CNPJ ${cnpj}: ${(e as Error).message}`);
      return null;
    }
  }
}

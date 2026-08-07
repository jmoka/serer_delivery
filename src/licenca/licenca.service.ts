import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LicencaStatus = {
  ativo: boolean; // false = esta instalação não tem LICENCA_SERIAL configurado (deployment central multi-tenant)
  bloqueado: boolean;
  revogado: boolean;
  dias_atraso: number;
  plano_nome: string | null;
  proxima_cobranca: string | null;
  ultima_consulta_ok: boolean;
  ultima_consulta_em: string | null;
};

const INTERVALO_PADRAO_MIN = 5;

// Só roda quando LICENCA_SERIAL está setado no .env — instalação central
// multi-tenant nunca configura isso, então fica sempre { ativo: false } lá.
@Injectable()
export class LicencaService implements OnModuleInit {
  private readonly logger = new Logger(LicencaService.name);
  private status: LicencaStatus = {
    ativo: false,
    bloqueado: false,
    revogado: false,
    dias_atraso: 0,
    plano_nome: null,
    proxima_cobranca: null,
    ultima_consulta_ok: false,
    ultima_consulta_em: null,
  };

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const serial = this.config.get<string>('LICENCA_SERIAL');
    if (!serial) return;

    this.status.ativo = true;
    const minutos = Number(this.config.get<string>('LICENCA_CHECKIN_INTERVALO_MIN')) || INTERVALO_PADRAO_MIN;
    this.checkin();
    setInterval(() => this.checkin(), minutos * 60 * 1000);
  }

  getStatus(): LicencaStatus {
    return this.status;
  }

  // Checkin sob demanda — usado pelo endpoint POST /licenca/checkin-agora
  // pra confirmar na hora uma troca/revogação feita pelo admin, sem esperar
  // o próximo ciclo automático.
  async forcarCheckin(): Promise<LicencaStatus> {
    await this.checkin();
    return this.status;
  }

  private async checkin() {
    const serial = this.config.get<string>('LICENCA_SERIAL');
    const centralUrl = this.config.get<string>('LICENCA_CENTRAL_URL');
    if (!serial || !centralUrl) {
      this.logger.warn('LICENCA_SERIAL configurado mas LICENCA_CENTRAL_URL ausente — checkin não pode rodar');
      return;
    }

    try {
      const res = await fetch(`${centralUrl.replace(/\/$/, '')}/instalacoes/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();

      this.status = {
        ativo: true,
        bloqueado: !!data.bloqueado,
        revogado: !!data.revogado,
        dias_atraso: data.dias_atraso ?? 0,
        plano_nome: data.plano_nome ?? null,
        proxima_cobranca: data.proxima_cobranca ?? null,
        ultima_consulta_ok: true,
        ultima_consulta_em: new Date().toISOString(),
      };
    } catch (e: any) {
      this.logger.warn(`Falha no checkin de licença: ${e?.message}`);
      // Instabilidade de rede/servidor central fora do ar não trava o cliente
      // na hora — mantém o último status de bloqueio conhecido. Revogação de
      // verdade vem como resposta 200 (bloqueado:true, revogado:true), não cai aqui.
      this.status = { ...this.status, ultima_consulta_ok: false };
    }
  }
}

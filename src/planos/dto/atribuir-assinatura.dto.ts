import { IsInt, IsISO8601, IsOptional } from 'class-validator';

export class AtribuirAssinaturaDto {
  @IsInt()
  plano_id: number;

  // Data até quando a mensalidade fica isenta (cortesia admin) — null explícito
  // remove a cortesia. "Grátis eterno" é só essa data bem no futuro (ver
  // PlanosService.atribuirAssinatura/atualizarCortesia).
  @IsOptional()
  @IsISO8601()
  cortesia_ate?: string | null;
}

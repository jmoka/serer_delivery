import { IsISO8601, IsOptional } from 'class-validator';

// Edita só a data de cortesia da assinatura já existente, sem trocar de plano
// (ver PlanosRestauranteController atribuirAssinatura pra trocar o plano_id).
export class AtualizarCortesiaDto {
  @IsOptional()
  @IsISO8601()
  cortesia_ate?: string | null;
}

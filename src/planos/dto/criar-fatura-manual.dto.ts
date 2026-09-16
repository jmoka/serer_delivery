import { IsInt, IsISO8601, IsNumber, IsOptional, Min } from 'class-validator';

// Fatura avulsa criada manualmente pelo admin — fora do ciclo automático de
// sincronizarPeriodo(). Exatamente um dos dois titulares deve vir preenchido.
export class CriarFaturaManualDto {
  @IsOptional()
  @IsInt()
  restaurant_id?: number;

  @IsOptional()
  @IsInt()
  instalacao_id?: number;

  @IsNumber()
  @Min(0)
  valor: number;

  @IsISO8601()
  vencimento: string;

  @IsISO8601()
  periodo_inicio: string;

  @IsISO8601()
  periodo_fim: string;
}

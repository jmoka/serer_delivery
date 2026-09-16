import { IsISO8601, IsNumber, IsOptional, Min } from 'class-validator';

export class AtualizarFaturaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  valor?: number;

  @IsOptional()
  @IsISO8601()
  vencimento?: string;
}

import { IsBoolean, IsNumber, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AtualizarPacoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nome?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  dias?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  preco?: number;

  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

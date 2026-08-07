import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class CriarPlanoDto {
  @IsString()
  @MaxLength(100)
  nome: string;

  @IsNumber()
  @Min(0)
  valor: number;

  @IsIn(['mensal', 'trimestral', 'anual'])
  periodicidade: 'mensal' | 'trimestral' | 'anual';

  @IsOptional()
  @IsInt()
  @Min(1)
  limite_produtos?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  piso_faturamento?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  trial_dias?: number;

  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @IsOptional()
  @IsBoolean()
  inclui_delivery?: boolean;

  @IsOptional()
  @IsBoolean()
  inclui_salao?: boolean;
}

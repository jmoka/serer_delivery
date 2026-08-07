import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class AtualizarPlanoDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nome?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  valor?: number;

  @IsOptional()
  @IsIn(['mensal', 'trimestral', 'anual'])
  periodicidade?: 'mensal' | 'trimestral' | 'anual';

  @IsOptional()
  @IsIn(['saas', 'local'])
  tipo?: 'saas' | 'local';

  // null explicito remove o limite (vira ilimitado)
  @IsOptional()
  @IsInt()
  @Min(1)
  limite_produtos?: number | null;

  // null explicito remove o piso (passa a cobrar sempre)
  @IsOptional()
  @IsNumber()
  @Min(0)
  piso_faturamento?: number | null;

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

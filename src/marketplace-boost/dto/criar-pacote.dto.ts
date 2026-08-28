import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CriarPacoteDto {
  @IsString()
  @MaxLength(100)
  nome: string;

  // Validado dinamicamente contra tags_catalogo (+ 'combos') no service —
  // não é uma lista fixa, admin pode criar tag nova a qualquer momento.
  @IsString()
  carrossel: string;

  @IsInt()
  @Min(1)
  @Max(20)
  qtd_produtos: number;

  @IsInt()
  @Min(1)
  @Max(365)
  dias: number;

  @IsNumber()
  @Min(0)
  preco: number;

  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

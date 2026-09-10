import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CriarPacoteDto {
  @IsString()
  @MaxLength(100)
  nome: string;

  // Composição do pacote (quais carrosséis + quantos itens em cada) vem
  // sempre de um perfil de vagas salvo (marketplace_boost_vagas_presets) —
  // congelado no momento da criação, não é uma referência viva ao preset.
  @IsInt()
  preset_id: number;

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

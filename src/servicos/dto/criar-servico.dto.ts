import { IsBoolean, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';

export class CriarServicoDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  image_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoria?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  preco_min?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  preco_max?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

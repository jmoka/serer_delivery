import { IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CriarInstalacaoDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  nome_cliente: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  contato?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dominio_ou_ip?: string;

  // Plano já atribuído na criação (opcional — admin pode atribuir depois)
  @IsOptional()
  @IsInt()
  plano_id?: number;
}

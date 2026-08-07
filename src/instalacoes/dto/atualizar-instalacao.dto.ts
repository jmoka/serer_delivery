import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AtualizarInstalacaoDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  nome_cliente?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  contato?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dominio_ou_ip?: string;

  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

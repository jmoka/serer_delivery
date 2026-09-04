import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SolicitarOrcamentoDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  nome_cliente: string;

  @IsString()
  @MinLength(8)
  @MaxLength(20)
  telefone_cliente: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  mensagem?: string;
}

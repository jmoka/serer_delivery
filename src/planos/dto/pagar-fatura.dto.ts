import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class PagarFaturaDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  nome: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(11)
  @MaxLength(18)
  cpf_cnpj: string;
}

import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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

  // Ausente = pix (compatibilidade com o fluxo antigo, só Pix)
  @IsOptional()
  @IsIn(['pix', 'credit_card', 'debit_card'])
  metodo?: 'pix' | 'credit_card' | 'debit_card';

  // Card token gerado no navegador via PagBank.js — obrigatório se metodo for cartão
  @IsOptional()
  @IsString()
  card_encrypted?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  parcelas?: number;
}

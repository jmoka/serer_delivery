import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Só exigido pelo PagBank em pagamento de cartão (antifraude) — Pix não usa.
export class EnderecoFaturaDto {
  @IsString()
  @MinLength(8)
  @MaxLength(9)
  cep: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  rua: string;

  @IsString()
  @MaxLength(20)
  numero: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  complemento?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  bairro: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  cidade: string;

  @IsString()
  @MinLength(2)
  @MaxLength(2)
  uf: string;
}

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

  // Obrigatório só pra credit_card/debit_card — validado no service, não aqui
  // (não dá pra condicionar @IsOptional em outro campo direto no decorator).
  @IsOptional()
  @ValidateNested()
  @Type(() => EnderecoFaturaDto)
  endereco?: EnderecoFaturaDto;
}

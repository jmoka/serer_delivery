import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class UpdateConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pagbank_platform_token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  pagbank_platform_account_id?: string;

  @IsOptional()
  @IsBoolean()
  pagbank_sandbox?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cloudflare_tunnel_token?: string;

  // Domínio: apenas letras, números, pontos e hífens
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-zA-Z0-9.-]*$/, { message: 'Domínio inválido — use apenas letras, números, pontos e hífens' })
  cloudflare_domain?: string;

  // Instalação individual: restringe o admin a 1 restaurante só (mono-estabelecimento)
  @IsOptional()
  @IsBoolean()
  modo_individual?: boolean;

  @IsOptional()
  @IsInt()
  modo_individual_restaurant_id?: number | null;

  // Comissão padrão da plataforma — usada por lojas com comissao_pct = NULL (sem override)
  @IsOptional()
  @IsNumber()
  @Min(0)
  comissao_padrao_pct?: number;

  // Dias de tolerância após vencimento de fatura de plano antes de bloquear o painel do dono
  @IsOptional()
  @IsInt()
  @Min(0)
  plano_dias_tolerancia?: number;
}

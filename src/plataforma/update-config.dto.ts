import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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
}

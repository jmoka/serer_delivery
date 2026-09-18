import { IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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

  // Kill-switch de split — desliga sem apagar token/account_id/contas dos
  // restaurantes. Enquanto desligado, todo pagamento cai no fluxo sem split
  // (token próprio de cada restaurante), mesmo com split configurado.
  @IsOptional()
  @IsBoolean()
  pagbank_split_habilitado?: boolean;

  // Como a PLATAFORMA recebe fatura de plano/pacote (admin) — 'manual' (só
  // Pix com a chave abaixo, admin confirma o recebimento à mão em
  // /admin/planos) ou 'pagbank' (Pix + Cartão via PagBank, como já era).
  @IsOptional()
  @IsString()
  faturamento_modo?: 'manual' | 'pagbank';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  faturamento_chave_pix?: string;

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

  // Quantas vezes um motoboy recusado pode pedir revisão do cadastro antes de travar
  @IsOptional()
  @IsInt()
  @Min(0)
  motoboy_limite_revisoes?: number;

  // Kill-switch de cadastro público — desliga o botão de quem ainda não tem
  // conta desse tipo. Loja/motoboy já cadastrado nunca é afetado.
  @IsOptional()
  @IsBoolean()
  permitir_cadastro_motoboy?: boolean;

  @IsOptional()
  @IsBoolean()
  permitir_cadastro_estabelecimento?: boolean;

  // Branding do marketplace público (/menu-catalog-product-browse) — validação
  // solta aqui, o whitelisting real de chaves é feito no service.
  @IsOptional()
  @IsObject()
  aparencia_marketplace?: Record<string, any>;

  // Stripe Connect — chave da plataforma (uma só, nunca por restaurante)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  stripe_secret_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  stripe_webhook_secret?: string;

  // Segredo de um endpoint de webhook SEPARADO, escopo "Contas conectadas" (Connect) —
  // payout.paid é evento da conta conectada, chega assinado com outra chave, diferente
  // do endpoint normal (escopo "Sua conta") usado pra payment_intent/account.updated.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  stripe_connect_webhook_secret?: string;
}

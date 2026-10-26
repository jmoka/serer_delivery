import { IsISO8601 } from 'class-validator';

// Admin desloca manualmente quando o período atual da assinatura termina
// (ultimo_periodo_faturado_fim) — usado em /admin/empresas pra editar o
// vencimento projetado quando ainda não existe fatura gerada pro período.
export class AtualizarVigenciaDto {
  @IsISO8601()
  ultimo_periodo_faturado_fim: string;
}

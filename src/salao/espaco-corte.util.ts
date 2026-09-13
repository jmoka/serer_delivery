// Acrescenta ao fim do conteúdo enviado ao agente de impressão local o espaço (em linhas
// de avanço de papel) configurado pra aquela impressora especificamente (ver coluna
// impressoras.espaco_corte_linhas) — soma-se ao avanço fixo de 3 linhas já embutido no
// agente (print-agent/printers.py, imprimir_texto), sem precisar recompilar/redistribuir
// o agente pra ajustar a folga antes do corte automático.
export function aplicarEspacoCorte(conteudo: string, espacoCorteLinhas: number | null | undefined): string {
  const linhas = Math.max(0, espacoCorteLinhas ?? 0);
  return linhas > 0 ? conteudo + '\n'.repeat(linhas) : conteudo;
}

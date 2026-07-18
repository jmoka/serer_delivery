// Normaliza domínio pra comparação/armazenamento: lowercase, sem protocolo/caminho
// (caso o dono cole a URL inteira por engano), sem "www." — restordemo.com e
// www.restordemo.com contam como o mesmo domínio.
export function normalizarDominio(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

const HOSTNAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validarFormatoDominio(dominio: string): boolean {
  return HOSTNAME_REGEX.test(dominio);
}

export function isDominioReservado(dominio: string): boolean {
  return dominio === 'localhost' || dominio === '127.0.0.1' || dominio.endsWith('.easypanel.host');
}

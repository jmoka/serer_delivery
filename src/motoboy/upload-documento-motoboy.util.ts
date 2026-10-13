import { R2Service } from '../r2/r2.service';

// Bucket privado — grava o path do objeto, não a URL (URL é gerada sob demanda
// via signed URL). Compartilhado entre MotoboyAuthService (self-signup) e
// MotoboyService (cadastro pelo restaurante) — mesma convenção de nome de
// arquivo pros dois fluxos de criação de motoboy. Migrado pro R2 em 2026-10-13
// (arquivos antigos copiados do Supabase preservando o mesmo path/chave).
export async function uploadDocumentoMotoboy(
  r2: R2Service,
  motoboyId: number,
  campo: string,
  base64: string,
): Promise<string> {
  const matches = base64.match(/^data:([\w/+-]+);base64,(.+)$/);
  const mimeType = matches ? matches[1] : 'image/jpeg';
  const raw = matches ? matches[2] : base64;
  const buffer = Buffer.from(raw, 'base64');
  const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
  const path = `${motoboyId}/${campo}-${Date.now()}.${ext}`;

  await r2.enviarArquivo(path, buffer, mimeType);

  return path;
}

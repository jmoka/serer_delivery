import { SupabaseService } from '../supabase/supabase.service';

const BUCKET = 'motoboy-documentos';

// Bucket privado — grava o path do objeto, não a URL (URL é gerada sob demanda
// via signed URL). Compartilhado entre MotoboyAuthService (self-signup) e
// MotoboyService (cadastro pelo restaurante) — mesmo bucket, mesma convenção
// de nome de arquivo pros dois fluxos de criação de motoboy.
export async function uploadDocumentoMotoboy(
  supabase: SupabaseService,
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

  const { error } = await supabase.client.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;

  return path;
}

// Roda UMA VEZ (por ambiente — local primeiro, depois produção) pra criptografar
// em repouso o que hoje está em texto plano: customers.cpf_cnpj/address_json,
// customer_addresses.address_json, restaurants.cnpj, motoboys.cnpj/chave_pix,
// motoboy_repasse_solicitacoes.chave_pix_motoboy. Também popula as colunas
// _hash (cpf_cnpj_hash/cnpj_hash) usadas pro dedupe depois que o valor real
// vira ciphertext (não dá mais pra comparar a coluna criptografada direto).
//
// Idempotente: pra cada linha, tenta decifrar o valor atual — se decifrar com
// sucesso, já está criptografado, pula; se falhar, trata como texto plano e
// criptografa. Rodar de novo (ex. depois de outra rodada de cadastros) não
// duplica nem quebra nada.
//
// Uso: npm run backfill:pii-encryption   (dentro de server_delivery, com .env
// configurado — precisa de SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// PII_ENCRYPTION_KEY, PII_HASH_KEY)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY;
const PII_HASH_KEY = process.env.PII_HASH_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PII_ENCRYPTION_KEY || !PII_HASH_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / PII_ENCRYPTION_KEY / PII_HASH_KEY ausentes no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Mesmo algoritmo/formato do EncryptionService (src/common/encryption.service.ts)
// — duplicado aqui de propósito: esse script roda fora do contexto do Nest
// (sem DI), então reimplementa a mesma lógica em vez de tentar instanciar o
// módulo inteiro só pra isso.
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const encKey = Buffer.from(PII_ENCRYPTION_KEY, 'base64');
const hashKey = Buffer.from(PII_HASH_KEY, 'base64');
if (encKey.length !== 32) throw new Error('PII_ENCRYPTION_KEY precisa decodificar pra 32 bytes');
if (hashKey.length !== 32) throw new Error('PII_HASH_KEY precisa decodificar pra 32 bytes');

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function tentarDecifrar(payload: string): boolean {
  const partes = payload.split(':');
  if (partes.length !== 3) return false;
  try {
    const [ivB64, tagB64, ctB64] = partes;
    const decipher = crypto.createDecipheriv(ALGO, encKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

function hashForLookup(normalized: string): string {
  return crypto.createHmac('sha256', hashKey).update(normalized).digest('hex');
}

function jaEhJsonCriptografado(value: any): boolean {
  return !!value && typeof value === 'object' && value.v === 1 && typeof value.enc === 'string';
}

const normalizarDigitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

const PAGE_SIZE = 500;

interface Contadores {
  criptografados: number;
  jaEstavam: number;
}

function novoContador(): Contadores {
  return { criptografados: 0, jaEstavam: 0 };
}

// Criptografa uma coluna TEXT simples (sem hash sibling) — chave_pix,
// chave_pix_motoboy. Pagina por id pra não estourar memória/limite do PostgREST
// numa base grande.
async function backfillColunaTexto(tabela: string, coluna: string): Promise<Contadores> {
  const c = novoContador();
  let ultimoId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select(`id, ${coluna}`)
      .not(coluna, 'is', null)
      .gt('id', ultimoId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data as any[]) {
      ultimoId = row.id;
      const valor = row[coluna] as string;
      if (!valor) continue;
      if (tentarDecifrar(valor)) {
        c.jaEstavam++;
        continue;
      }
      const { error: updErro } = await supabase.from(tabela).update({ [coluna]: encrypt(valor) }).eq('id', row.id);
      if (updErro) throw updErro;
      c.criptografados++;
    }
    if (data.length < PAGE_SIZE) break;
  }
  return c;
}

// Criptografa uma coluna TEXT que tem um índice cego _hash ao lado (cpf_cnpj,
// cnpj) — popula coluna_hash com HMAC do valor normalizado (só dígitos), além
// de criptografar a coluna em si.
async function backfillColunaComHash(tabela: string, coluna: string, colunaHash: string): Promise<Contadores> {
  const c = novoContador();
  let ultimoId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select(`id, ${coluna}, ${colunaHash}`)
      .not(coluna, 'is', null)
      .gt('id', ultimoId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data as any[]) {
      ultimoId = row.id;
      const valor = row[coluna] as string;
      if (!valor) continue;
      if (tentarDecifrar(valor)) {
        c.jaEstavam++;
        continue;
      }
      const digitos = normalizarDigitos(valor);
      const { error: updErro } = await supabase
        .from(tabela)
        .update({ [coluna]: encrypt(valor), [colunaHash]: digitos ? hashForLookup(digitos) : null })
        .eq('id', row.id);
      if (updErro) throw updErro;
      c.criptografados++;
    }
    if (data.length < PAGE_SIZE) break;
  }
  return c;
}

// Criptografa uma coluna JSONB (address_json), preservando o tipo JSONB —
// grava {v:1, enc: ciphertext} no lugar do objeto em claro.
async function backfillAddressJson(tabela: string): Promise<Contadores> {
  const c = novoContador();
  let ultimoId = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select('id, address_json')
      .not('address_json', 'is', null)
      .gt('id', ultimoId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data as any[]) {
      ultimoId = row.id;
      const valor = row.address_json;
      if (!valor) continue;
      if (jaEhJsonCriptografado(valor)) {
        c.jaEstavam++;
        continue;
      }
      const wrapped = { v: 1, enc: encrypt(JSON.stringify(valor)) };
      const { error: updErro } = await supabase.from(tabela).update({ address_json: wrapped }).eq('id', row.id);
      if (updErro) throw updErro;
      c.criptografados++;
    }
    if (data.length < PAGE_SIZE) break;
  }
  return c;
}

async function main() {
  const relatorio: { alvo: string; contador: Contadores }[] = [];

  relatorio.push({ alvo: 'customers.cpf_cnpj', contador: await backfillColunaComHash('customers', 'cpf_cnpj', 'cpf_cnpj_hash') });
  relatorio.push({ alvo: 'customers.address_json', contador: await backfillAddressJson('customers') });
  relatorio.push({ alvo: 'customer_addresses.address_json', contador: await backfillAddressJson('customer_addresses') });
  relatorio.push({ alvo: 'restaurants.cnpj', contador: await backfillColunaComHash('restaurants', 'cnpj', 'cnpj_hash') });
  relatorio.push({ alvo: 'motoboys.cnpj', contador: await backfillColunaComHash('motoboys', 'cnpj', 'cnpj_hash') });
  relatorio.push({ alvo: 'motoboys.chave_pix', contador: await backfillColunaTexto('motoboys', 'chave_pix') });
  relatorio.push({
    alvo: 'motoboy_repasse_solicitacoes.chave_pix_motoboy',
    contador: await backfillColunaTexto('motoboy_repasse_solicitacoes', 'chave_pix_motoboy'),
  });

  console.log('\nBackfill de criptografia de PII concluído:\n');
  for (const { alvo, contador } of relatorio) {
    console.log(`  ${alvo.padEnd(45)} criptografados: ${contador.criptografados}   já estavam: ${contador.jaEstavam}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

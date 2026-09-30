import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

// Criptografia de dado sensível em repouso (CPF/CNPJ, PIX, endereço) — AES-256-GCM
// com IV aleatório por valor (não determinístico, cada chamada de encrypt() do mesmo
// texto gera ciphertext diferente). Por isso colunas que precisam de busca exata
// (dedupe de CNPJ etc.) NUNCA comparam a coluna criptografada direto — usam um
// índice cego (hashForLookup, HMAC com chave separada) numa coluna _hash ao lado.
//
// PII_ENCRYPTION_KEY e PII_HASH_KEY são independentes de propósito: vazar uma não
// compromete a outra (uma decifra o dado, a outra só permite testar igualdade).
// Geradas com `openssl rand -base64 32`, nunca no código — ver .env.example.
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;
  private readonly hashKey: Buffer;

  constructor(config: ConfigService) {
    this.key = this.carregarChave(config, 'PII_ENCRYPTION_KEY');
    this.hashKey = this.carregarChave(config, 'PII_HASH_KEY');
  }

  private carregarChave(config: ConfigService, nome: string): Buffer {
    const valor = config.getOrThrow<string>(nome);
    const buf = Buffer.from(valor, 'base64');
    if (buf.length !== 32) {
      throw new Error(`${nome} precisa decodificar (base64) pra exatos 32 bytes — gere com "openssl rand -base64 32".`);
    }
    return buf;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const partes = payload.split(':');
    if (partes.length !== 3) {
      throw new Error('Payload não está no formato criptografado esperado (iv:authTag:ciphertext) — verifique se a coluna foi migrada.');
    }
    const [ivB64, tagB64, ctB64] = partes;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  // Índice cego pra dedupe/lookup exato sobre valor criptografado (ex.: CNPJ já
  // cadastrado) — normalizar (remover pontuação etc.) ANTES de chamar, no mesmo
  // formato usado ao gravar, senão o hash nunca bate.
  hashForLookup(normalized: string): string {
    return crypto.createHmac('sha256', this.hashKey).update(normalized).digest('hex');
  }

  encryptNullable(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    return this.encrypt(plaintext);
  }

  decryptNullable(payload: string | null | undefined): string | null {
    if (payload === null || payload === undefined || payload === '') return null;
    return this.decrypt(payload);
  }

  // Envelope pra coluna JSONB (address_json): mantém o tipo JSONB válido no Postgres —
  // só o conteúdo vira ciphertext dentro de um objeto versionado (v: formato do
  // envelope, pra permitir trocar de esquema no futuro sem quebrar linhas antigas).
  encryptJson(value: Record<string, any> | null | undefined): { v: 1; enc: string } | null {
    if (value === null || value === undefined) return null;
    return { v: 1, enc: this.encrypt(JSON.stringify(value)) };
  }

  decryptJson<T = Record<string, any>>(wrapped: { v: number; enc: string } | null | undefined): T | null {
    if (wrapped === null || wrapped === undefined) return null;
    if (typeof wrapped !== 'object' || typeof wrapped.enc !== 'string') {
      throw new Error('address_json não está no formato criptografado esperado {v, enc} — essa linha pode não ter passado pelo backfill.');
    }
    return JSON.parse(this.decrypt(wrapped.enc));
  }
}

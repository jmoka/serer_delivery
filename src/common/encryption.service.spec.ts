import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

function configComChaves() {
  const chaves: Record<string, string> = {
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    PII_HASH_KEY: Buffer.alloc(32, 2).toString('base64'),
  };
  return { getOrThrow: (nome: string) => chaves[nome] } as unknown as ConfigService;
}

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(() => {
    service = new EncryptionService(configComChaves());
  });

  it('rejeita chave com tamanho errado', () => {
    const configRuim = { getOrThrow: () => Buffer.alloc(16).toString('base64') } as unknown as ConfigService;
    expect(() => new EncryptionService(configRuim)).toThrow('32 bytes');
  });

  it('encrypt/decrypt faz round-trip', () => {
    const original = '123.456.789-00';
    const ciphertext = service.encrypt(original);
    expect(ciphertext).not.toBe(original);
    expect(service.decrypt(ciphertext)).toBe(original);
  });

  it('duas criptografias do mesmo texto geram ciphertexts diferentes (IV aleatório)', () => {
    const a = service.encrypt('mesmo valor');
    const b = service.encrypt('mesmo valor');
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe('mesmo valor');
    expect(service.decrypt(b)).toBe('mesmo valor');
  });

  it('decrypt lança erro se o ciphertext foi adulterado (autenticidade do GCM)', () => {
    const ciphertext = service.encrypt('dado sensível');
    const [iv, tag, ct] = ciphertext.split(':');
    const ctAdulterado = Buffer.from(ct, 'base64');
    ctAdulterado[0] ^= 0xff;
    const adulterado = `${iv}:${tag}:${ctAdulterado.toString('base64')}`;
    expect(() => service.decrypt(adulterado)).toThrow();
  });

  it('hashForLookup é determinístico e diferencia valores diferentes', () => {
    expect(service.hashForLookup('12345678900')).toBe(service.hashForLookup('12345678900'));
    expect(service.hashForLookup('12345678900')).not.toBe(service.hashForLookup('00987654321'));
  });

  it('encryptNullable/decryptNullable tratam null e vazio sem lançar erro', () => {
    expect(service.encryptNullable(null)).toBeNull();
    expect(service.encryptNullable(undefined)).toBeNull();
    expect(service.encryptNullable('')).toBeNull();
    expect(service.decryptNullable(null)).toBeNull();

    const enc = service.encryptNullable('12345678900');
    expect(enc).not.toBeNull();
    expect(service.decryptNullable(enc)).toBe('12345678900');
  });

  it('encryptJson/decryptJson fazem round-trip preservando o objeto', () => {
    const endereco = { logradouro: 'Rua A', numero: '100', bairro: 'Centro' };
    const wrapped = service.encryptJson(endereco);
    expect(wrapped).toMatchObject({ v: 1 });
    expect(service.decryptJson(wrapped)).toEqual(endereco);
  });

  it('decryptJson lança erro se o valor não estiver no formato {v, enc} esperado', () => {
    expect(() => service.decryptJson({ logradouro: 'Rua A' } as any)).toThrow('formato criptografado esperado');
  });

  it('encryptJson/decryptJson tratam null', () => {
    expect(service.encryptJson(null)).toBeNull();
    expect(service.decryptJson(null)).toBeNull();
  });
});

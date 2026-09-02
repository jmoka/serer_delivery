import { generateSecret, generateURI, verify } from 'otplib';

// Nome que aparece no app autenticador (Google Authenticator, Authy etc.)
// junto do email do usuário.
const ISSUER = 'PediuVai';

export function gerarSegredoTotp(): string {
  return generateSecret();
}

export function gerarOtpAuthUrl(email: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: email, secret });
}

export async function verificarCodigoTotp(secret: string, codigo: string): Promise<boolean> {
  try {
    const resultado = await verify({ secret, token: codigo });
    return resultado.valid;
  } catch {
    return false;
  }
}

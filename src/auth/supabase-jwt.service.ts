import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

// Verificação de JWT do Supabase Auth reaproveitável fora de guards — usado
// quando um endpoint público (ex: cadastro de motoboy) opcionalmente recebe
// o token de uma sessão de cliente já logada, pra vincular as duas contas.
@Injectable()
export class SupabaseJwtService {
  private jwksClient: JwksClient;

  constructor(private config: ConfigService) {
    const supabaseUrl = this.config.getOrThrow('SUPABASE_URL');
    this.jwksClient = new JwksClient({
      jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600000,
    });
  }

  async verificar(token: string): Promise<jwt.JwtPayload | null> {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') return null;

      const key = await this.jwksClient.getSigningKey(decoded.header.kid);
      return jwt.verify(token, key.getPublicKey()) as jwt.JwtPayload;
    } catch {
      return null;
    }
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

@Injectable()
export class JwtGuard implements CanActivate {
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'] as string | undefined;

    if (!authHeader?.startsWith('Bearer ')) return false;

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') throw new Error('invalid');

      const key = await this.jwksClient.getSigningKey(decoded.header.kid);
      const verified = jwt.verify(token, key.getPublicKey()) as jwt.JwtPayload;

      request.userId = verified.sub;
      request.userRole = verified.user_metadata?.role ?? 'customer';
      return true;
    } catch {
      throw new UnauthorizedException('Token JWT inválido');
    }
  }
}

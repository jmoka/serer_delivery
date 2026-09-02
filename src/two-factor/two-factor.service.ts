import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { RedisService } from '../redis/redis.service';
import { TwoFactorEmailService } from './two-factor-email.service';
import { gerarSegredoTotp, gerarOtpAuthUrl, verificarCodigoTotp } from './totp.util';

const CHALLENGE_TTL_S = 5 * 60;
const MAX_TENTATIVAS_CODIGO = 5;

type Metodo2FA = 'none' | 'totp' | 'email';

interface Desafio2FA {
  userId: string;
  method: 'totp' | 'email';
  session: { access_token: string; refresh_token: string };
  code?: string; // só method 'email'
  secret?: string; // snapshot do segredo TOTP no momento do login, só method 'totp'
}

const chaveDesafio = (id: string) => `2fa:challenge:${id}`;
const chaveTentativas = (id: string) => `2fa:tentativas:${id}`;

@Injectable()
export class TwoFactorService {
  // Client isolado (sem persistir sessão), mesmo motivo do AuthLoginService:
  // usado só pra reautenticar com senha antes de desativar o 2FA.
  private readonly authClient: SupabaseClient;

  constructor(
    private supabase: SupabaseService,
    private redis: RedisService,
    private email: TwoFactorEmailService,
    config: ConfigService,
  ) {
    this.authClient = createClient(
      config.getOrThrow('SUPABASE_URL'),
      config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  // ── Usado pelo AuthLoginService, logo após signInWithPassword ter sucesso ──

  async criarDesafio(params: {
    userId: string;
    method: 'totp' | 'email';
    email: string;
    session: { access_token: string; refresh_token: string };
  }): Promise<{ challengeId: string }> {
    const challengeId = crypto.randomUUID();
    const desafio: Desafio2FA = { userId: params.userId, method: params.method, session: params.session };

    if (params.method === 'email') {
      desafio.code = String(Math.floor(100000 + Math.random() * 900000));
      await this.email.enviarCodigo(params.email, desafio.code);
    } else {
      const { data } = await this.supabase.client
        .from('user_profiles')
        .select('two_factor_totp_secret')
        .eq('id', params.userId)
        .maybeSingle();
      if (!data?.two_factor_totp_secret) throw new BadRequestException('2FA por app autenticador não está configurado corretamente.');
      desafio.secret = data.two_factor_totp_secret;
    }

    await this.redis.setJSONStrict(chaveDesafio(challengeId), desafio, CHALLENGE_TTL_S);
    return { challengeId };
  }

  async verificarDesafio(challengeId: string, codigo: string) {
    if (!challengeId || !codigo) throw new BadRequestException('Informe o código.');

    const tentativas = await this.redis.incrWithTtl(chaveTentativas(challengeId), CHALLENGE_TTL_S);
    if (tentativas > MAX_TENTATIVAS_CODIGO) {
      await this.redis.del(chaveDesafio(challengeId));
      throw new UnauthorizedException('Muitas tentativas erradas. Faça login novamente.');
    }

    const desafio = await this.redis.getJSONStrict<Desafio2FA>(chaveDesafio(challengeId));
    if (!desafio) throw new UnauthorizedException('Código expirado. Faça login novamente.');

    const valido =
      desafio.method === 'email' ? codigo === desafio.code : await verificarCodigoTotp(desafio.secret!, codigo);

    if (!valido) throw new UnauthorizedException('Código inválido.');

    await this.redis.del(chaveDesafio(challengeId));
    await this.redis.del(chaveTentativas(challengeId));
    return desafio.session;
  }

  // ── Gerenciamento (usuário já logado, JwtGuard) ──

  async getStatus(userId: string): Promise<{ method: Metodo2FA }> {
    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('two_factor_method')
      .eq('id', userId)
      .maybeSingle();
    return { method: (data?.two_factor_method as Metodo2FA) ?? 'none' };
  }

  async iniciarEnrollTotp(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const { data } = await this.supabase.client.from('user_profiles').select('email').eq('id', userId).maybeSingle();
    if (!data?.email) throw new BadRequestException('Perfil sem email cadastrado.');

    const secret = gerarSegredoTotp();
    return { secret, otpauthUrl: gerarOtpAuthUrl(data.email, secret) };
  }

  async confirmarEnrollTotp(userId: string, secret: string, codigo: string): Promise<{ method: Metodo2FA }> {
    const valido = await verificarCodigoTotp(secret, codigo);
    if (!valido) throw new BadRequestException('Código inválido — confira o app autenticador e tente de novo.');

    await this.supabase.client
      .from('user_profiles')
      .update({ two_factor_method: 'totp', two_factor_totp_secret: secret })
      .eq('id', userId);
    return { method: 'totp' };
  }

  async enrollEmail(userId: string): Promise<{ method: Metodo2FA }> {
    await this.supabase.client
      .from('user_profiles')
      .update({ two_factor_method: 'email', two_factor_totp_secret: null })
      .eq('id', userId);
    return { method: 'email' };
  }

  async desativar(userId: string, senhaAtual: string): Promise<{ method: Metodo2FA }> {
    const { data: perfil } = await this.supabase.client
      .from('user_profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    if (!perfil?.email) throw new ForbiddenException();

    const { error } = await this.authClient.auth.signInWithPassword({ email: perfil.email, password: senhaAtual });
    if (error) throw new UnauthorizedException('Senha atual incorreta.');

    await this.supabase.client
      .from('user_profiles')
      .update({ two_factor_method: 'none', two_factor_totp_secret: null })
      .eq('id', userId);
    return { method: 'none' };
  }
}

import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { RedisService } from '../redis/redis.service';
import { TwoFactorEmailService } from './two-factor-email.service';
import { gerarSegredoTotp, gerarOtpAuthUrl, verificarCodigoTotp } from './totp.util';

const CHALLENGE_TTL_S = 5 * 60;
const MAX_TENTATIVAS_CODIGO = 5;
const VERIFICACAO_EMAIL_TTL_S = 10 * 60;

type Metodo2FA = 'none' | 'totp' | 'email';

interface VerificacaoEmailSeguranca {
  email: string;
  codigo: string;
}

const chaveVerificacaoEmail = (userId: string) => `email-seguranca:verificacao:${userId}`;
const chaveTentativasEmail = (userId: string) => `email-seguranca:tentativas:${userId}`;

const RESET_SENHA_TTL_S = 15 * 60;

interface DesafioResetSenha {
  userId: string;
  codigo: string;
}

const chaveResetSenha = (resetId: string) => `reset-senha:${resetId}`;
const chaveTentativasResetSenha = (resetId: string) => `reset-senha:tentativas:${resetId}`;

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
    // Exige e-mail de segurança já verificado — sem isso, o código de 2FA iria
    // pro e-mail de login, que é exatamente o que pode ser fake/inexistente
    // (ver EmailSegurancaService/motivação no topo do módulo).
    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('email_seguranca_verificado_em')
      .eq('id', userId)
      .maybeSingle();
    if (!data?.email_seguranca_verificado_em) {
      throw new BadRequestException('Verifique um e-mail de segurança antes de ativar o 2FA por e-mail.');
    }

    await this.supabase.client
      .from('user_profiles')
      .update({ two_factor_method: 'email', two_factor_totp_secret: null })
      .eq('id', userId);
    return { method: 'email' };
  }

  // ── E-mail de segurança (endereço alternativo, usado por 2FA por e-mail e
  // recuperação de senha — ver motivação no topo do arquivo de migration) ──

  async getStatusEmailSeguranca(userId: string): Promise<{ email_seguranca: string | null; verificado: boolean }> {
    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('email_seguranca, email_seguranca_verificado_em')
      .eq('id', userId)
      .maybeSingle();
    return { email_seguranca: data?.email_seguranca ?? null, verificado: !!data?.email_seguranca_verificado_em };
  }

  async solicitarVerificacaoEmailSeguranca(userId: string, email: string): Promise<{ enviado: true }> {
    const emailNormalizado = (email ?? '').trim().toLowerCase();
    if (!emailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      throw new BadRequestException('Informe um e-mail válido.');
    }

    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    await this.email.enviarCodigo(emailNormalizado, codigo);
    await this.redis.setJSONStrict(
      chaveVerificacaoEmail(userId),
      { email: emailNormalizado, codigo } satisfies VerificacaoEmailSeguranca,
      VERIFICACAO_EMAIL_TTL_S,
    );
    return { enviado: true };
  }

  async confirmarVerificacaoEmailSeguranca(userId: string, codigo: string): Promise<{ email_seguranca: string; verificado: true }> {
    if (!codigo) throw new BadRequestException('Informe o código.');

    const tentativas = await this.redis.incrWithTtl(chaveTentativasEmail(userId), VERIFICACAO_EMAIL_TTL_S);
    if (tentativas > MAX_TENTATIVAS_CODIGO) {
      await this.redis.del(chaveVerificacaoEmail(userId));
      throw new BadRequestException('Muitas tentativas erradas — solicite um novo código.');
    }

    const pendente = await this.redis.getJSONStrict<VerificacaoEmailSeguranca>(chaveVerificacaoEmail(userId));
    if (!pendente) throw new BadRequestException('Código expirado — solicite um novo.');
    if (pendente.codigo !== codigo) throw new BadRequestException('Código inválido.');

    await this.supabase.client
      .from('user_profiles')
      .update({ email_seguranca: pendente.email, email_seguranca_verificado_em: new Date().toISOString() })
      .eq('id', userId);

    await this.redis.del(chaveVerificacaoEmail(userId));
    await this.redis.del(chaveTentativasEmail(userId));
    return { email_seguranca: pendente.email, verificado: true };
  }

  async removerEmailSeguranca(userId: string): Promise<{ email_seguranca: null }> {
    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('two_factor_method')
      .eq('id', userId)
      .maybeSingle();
    if (data?.two_factor_method === 'email') {
      throw new BadRequestException('Desative o 2FA por e-mail antes de remover o e-mail de segurança.');
    }

    await this.supabase.client
      .from('user_profiles')
      .update({ email_seguranca: null, email_seguranca_verificado_em: null })
      .eq('id', userId);
    return { email_seguranca: null };
  }

  // ── Recuperação de senha via e-mail de segurança (AuthLoginService chama
  // depois de resolver o e-mail de login pro userId/email_seguranca) ──

  async enviarCodigoRecuperacaoSenha(userId: string, emailDestino: string): Promise<{ resetId: string }> {
    const resetId = crypto.randomUUID();
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    await this.email.enviarCodigo(emailDestino, codigo);
    await this.redis.setJSONStrict(
      chaveResetSenha(resetId),
      { userId, codigo } satisfies DesafioResetSenha,
      RESET_SENHA_TTL_S,
    );
    return { resetId };
  }

  async verificarCodigoRecuperacaoSenha(resetId: string, codigo: string): Promise<{ userId: string }> {
    if (!resetId || !codigo) throw new BadRequestException('Informe o código.');

    const tentativas = await this.redis.incrWithTtl(chaveTentativasResetSenha(resetId), RESET_SENHA_TTL_S);
    if (tentativas > MAX_TENTATIVAS_CODIGO) {
      await this.redis.del(chaveResetSenha(resetId));
      throw new UnauthorizedException('Muitas tentativas erradas. Solicite a recuperação novamente.');
    }

    const desafio = await this.redis.getJSONStrict<DesafioResetSenha>(chaveResetSenha(resetId));
    if (!desafio) throw new UnauthorizedException('Código expirado. Solicite a recuperação novamente.');
    if (desafio.codigo !== codigo) throw new UnauthorizedException('Código inválido.');

    await this.redis.del(chaveResetSenha(resetId));
    await this.redis.del(chaveTentativasResetSenha(resetId));
    return { userId: desafio.userId };
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

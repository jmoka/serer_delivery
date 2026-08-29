import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';

// Bloqueio por conta após várias senhas erradas seguidas no login principal
// (cliente/dono/admin, via Supabase Auth) — mesmo padrão já aplicado ao garçom
// (ver garcom-auth.service.ts). Só é possível contar "senha errada" com
// segurança porque é ESTE serviço quem verifica a senha (via
// supabase.auth.signInWithPassword no backend) — se o registro de falha fosse
// um endpoint separado confiando no que o navegador diz, alguém poderia
// "travar" a conta de outra pessoa só chutando o email, sem saber a senha.
const MAX_TENTATIVAS_LOGIN = 5;
const BLOQUEIO_LOGIN_MS = 5 * 60 * 1000;

@Injectable()
export class AuthLoginService {
  // Instância própria (não persiste sessão) só pra verificar a senha — NUNCA
  // reaproveitar this.supabase.client pra isso: signInWithPassword guarda a sessão
  // logada dentro do próprio client, e como o client do SupabaseService é um
  // singleton compartilhado por toda a aplicação, logar um usuário nele sequestraria
  // a "identidade" usada por TODAS as outras queries service_role em andamento em
  // outras requisições — risco sério de vazamento de dados entre requests. A chave
  // usada aqui não importa pro resultado do login (o token emitido reflete o usuário
  // autenticado, não a apikey da chamada) — reaproveita SUPABASE_SERVICE_ROLE_KEY em
  // vez de exigir uma env var nova (SUPABASE_ANON_KEY não existe hoje no .env do backend).
  private readonly authClient: SupabaseClient;

  constructor(
    private supabase: SupabaseService,
    config: ConfigService,
  ) {
    this.authClient = createClient(
      config.getOrThrow('SUPABASE_URL'),
      config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  private erroBloqueado(bloqueadoAte: string): never {
    throw new HttpException(
      { message: 'Muitas tentativas com senha errada. Aguarde para tentar de novo ou peça pro administrador liberar.', bloqueado_ate: bloqueadoAte },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async login(email: string, password: string) {
    if (!email || !password) throw new BadRequestException('Informe email e senha');
    const emailNormalizado = email.trim().toLowerCase();

    const { data: perfil } = await this.supabase.client
      .from('user_profiles')
      .select('id, tentativas_login_falhas, bloqueado_login_ate')
      .eq('email', emailNormalizado)
      .maybeSingle();

    if (perfil?.bloqueado_login_ate && new Date(perfil.bloqueado_login_ate).getTime() > Date.now()) {
      this.erroBloqueado(perfil.bloqueado_login_ate);
    }

    const { data, error } = await this.authClient.auth.signInWithPassword({ email: emailNormalizado, password });

    if (error || !data?.session) {
      // Sem perfil correspondente (email não cadastrado) não tem o que bloquear —
      // e não revela pro chamador se o email existe ou não (mesma mensagem genérica).
      if (perfil) {
        const tentativas = (perfil.tentativas_login_falhas ?? 0) + 1;
        if (tentativas >= MAX_TENTATIVAS_LOGIN) {
          const bloqueadoAte = new Date(Date.now() + BLOQUEIO_LOGIN_MS).toISOString();
          await this.supabase.client.from('user_profiles').update({ tentativas_login_falhas: 0, bloqueado_login_ate: bloqueadoAte }).eq('id', perfil.id);
          // Bloqueio de verdade no Supabase Auth (não só cosmético/no nosso banco) —
          // mesmo mecanismo (ban_duration) que UsuariosService.bloquear já usa pro
          // bloqueio manual do admin, só que temporário e autoexpirável.
          await this.supabase.client.auth.admin.updateUserById(perfil.id, { ban_duration: '5m' });
          this.erroBloqueado(bloqueadoAte);
        }
        await this.supabase.client.from('user_profiles').update({ tentativas_login_falhas: tentativas }).eq('id', perfil.id);
      }
      throw new UnauthorizedException(error?.message ?? 'Credenciais inválidas');
    }

    if (perfil && (perfil.tentativas_login_falhas || perfil.bloqueado_login_ate)) {
      await this.supabase.client.from('user_profiles').update({ tentativas_login_falhas: 0, bloqueado_login_ate: null }).eq('id', perfil.id);
    }

    return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
  }
}

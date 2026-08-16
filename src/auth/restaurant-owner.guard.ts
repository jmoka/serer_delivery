import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { CorsOriginsService } from '../common/cors-origins.service';
import { normalizarDominio } from '../common/dominio.util';

@Injectable()
export class RestaurantOwnerGuard implements CanActivate {
  constructor(
    private jwtGuard: JwtGuard,
    private supabase: SupabaseService,
    private corsOrigins: CorsOriginsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const userId: string = request.userId;

    const { data } = await this.supabase.client
      .from('restaurants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) {
      throw new ForbiddenException('Nenhum restaurante vinculado a este usuário');
    }

    // Domínio White Label (ex: recantodofarol.teusite.top) pertence a UMA loja só. O
    // navegador manda a origem automaticamente (Origin/Referer não são editáveis por
    // JS de terceiros) — se ela pertence a outra loja, as credenciais logadas não
    // podem operar ali, mesmo sendo válidas (bug real encontrado em produção:
    // dono de qualquer loja conseguia logar no domínio de outra e ver seu próprio painel).
    const origem = request.headers['origin'] || request.headers['referer'];
    // Domínio "base" da plataforma (app principal/dev) é compartilhado por TODAS as
    // lojas, não é White Label de nenhuma específica — pular a checagem de posse do
    // custom_domain aqui, senão qualquer loja cujo custom_domain bata (por acidente
    // de cadastro, ou simplesmente por ainda não ter loja nenhuma com domínio próprio
    // sendo comparada) passa a bloquear TODO MUNDO que acessa pelo domínio principal.
    if (origem && !this.corsOrigins.ehDominioBase(origem)) {
      const dominio = normalizarDominio(origem);
      const { data: donoDoDominio } = await this.supabase.client
        .from('restaurants')
        .select('id')
        .eq('custom_domain', dominio)
        .maybeSingle();

      if (donoDoDominio && donoDoDominio.id !== data.id) {
        throw new ForbiddenException('Essas credenciais não pertencem a esta loja');
      }
    }

    request.restaurantId = data.id;
    return true;
  }
}

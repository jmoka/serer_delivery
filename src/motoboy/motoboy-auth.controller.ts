import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MotoboyAuthService } from './motoboy-auth.service';
import type { CadastroMotoboyBody } from './motoboy-auth.service';
import { MotoboyGuard } from '../auth/motoboy.guard';

@Controller('motoboy/auth')
export class MotoboyAuthController {
  constructor(private service: MotoboyAuthService) {}

  // Cadastro: 10 por hora (ver POLITICAS.md do vault de segurança)
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('cadastro')
  cadastro(@Body() body: CadastroMotoboyBody) {
    return this.service.cadastro(body);
  }

  // Login: 5 tentativas por minuto (ver POLITICAS.md do vault de segurança)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() body: { identificador: string; password: string }) {
    return this.service.login(body.identificador, body.password);
  }

  // Motoboys criados antes do login por senha — aceita o token legado (x-motoboy-token = access_token antigo).
  @Post('completar-cadastro')
  @UseGuards(MotoboyGuard)
  completarCadastro(@Body() body: CadastroMotoboyBody, @Req() req: any) {
    return this.service.completarCadastro(req.motoboyId, body);
  }

  @Post('logout')
  @UseGuards(MotoboyGuard)
  logout(@Req() req: any) {
    return this.service.logout(req.motoboyId);
  }
}

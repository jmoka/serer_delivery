import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from '../auth/jwt.guard';
import { TwoFactorService } from './two-factor.service';

// Gerenciamento do 2FA (usuário já autenticado) — status/ativar/desativar.
// A verificação do código DURANTE o login (POST /auth-principal/verify-2fa)
// fica no AuthLoginController, junto do login em si — ver auth-login.controller.ts.
@Controller('auth-principal/2fa')
@UseGuards(JwtGuard)
export class TwoFactorController {
  constructor(private service: TwoFactorService) {}

  @Get()
  status(@Req() req: any) {
    return this.service.getStatus(req.userId);
  }

  @Post('enroll/totp')
  enrollTotp(@Req() req: any) {
    return this.service.iniciarEnrollTotp(req.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('enroll/totp/confirm')
  confirmarEnrollTotp(@Req() req: any, @Body() body: { secret: string; code: string }) {
    return this.service.confirmarEnrollTotp(req.userId, body.secret, body.code);
  }

  @Post('enroll/email')
  enrollEmail(@Req() req: any) {
    return this.service.enrollEmail(req.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('disable')
  disable(@Req() req: any, @Body() body: { password: string }) {
    return this.service.desativar(req.userId, body.password);
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthLoginService } from './auth-login.service';

@Controller('auth-principal')
export class AuthLoginController {
  constructor(private service: AuthLoginService) {}

  // Login principal (cliente/dono/admin) mediado pelo backend — necessário pro
  // bloqueio por tentativas (ver AuthLoginService). Limite mais folgado que o do
  // garçom (5/min, tablet único do restaurante): aqui o mesmo IP pode ser vários
  // clientes atrás de NAT/rede móvel compartilhada.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.service.login(body.email, body.password);
  }

  // Segundo passo do login quando a conta tem 2FA ativo (ver AuthLoginService.login,
  // que devolve requires2fa+challenge_id em vez dos tokens direto). Rate-limit mais
  // apertado que o login: challenge_id só existe pra quem já acertou a senha, mas o
  // código de 6 dígitos ainda pode ser tentado por força bruta.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-2fa')
  verify2fa(@Body() body: { challenge_id: string; code: string }) {
    return this.service.verifyTwoFactor(body.challenge_id, body.code);
  }
}

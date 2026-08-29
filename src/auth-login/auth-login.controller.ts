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
}

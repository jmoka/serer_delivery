import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GarcomAuthService } from './garcom-auth.service';

@Controller('garcom/auth')
export class GarcomAuthController {
  constructor(private service: GarcomAuthService) {}

  // Login: 5 tentativas por minuto (ver POLITICAS.md do vault de segurança)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() body: { login_key: string; password: string }) {
    return this.service.login(body.login_key, body.password);
  }
}

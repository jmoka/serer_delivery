import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MotoboyAuthService } from './motoboy-auth.service';
import type { CompletarCadastroMotoboyBody } from './motoboy-auth.service';
import { JwtGuard } from '../auth/jwt.guard';

@Controller('motoboy/auth')
export class MotoboyAuthController {
  constructor(private service: MotoboyAuthService) {}

  // Conta já foi criada client-side via supabase.auth.signUp() — aqui só
  // completa o cadastro (docs, telefone). 10/hora (ver POLITICAS.md do vault de segurança).
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('completar-cadastro')
  @UseGuards(JwtGuard)
  completarCadastro(@Body() body: CompletarCadastroMotoboyBody, @Req() req: any) {
    return this.service.completarCadastro(req.userId, body);
  }
}

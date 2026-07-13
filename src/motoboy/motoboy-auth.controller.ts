import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { MotoboyAuthService } from './motoboy-auth.service';
import type { CadastroMotoboyBody } from './motoboy-auth.service';
import { MotoboyGuard } from '../auth/motoboy.guard';

@Controller('motoboy/auth')
export class MotoboyAuthController {
  constructor(private service: MotoboyAuthService) {}

  @Post('cadastro')
  cadastro(@Body() body: CadastroMotoboyBody) {
    return this.service.cadastro(body);
  }

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
}

import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { PerfilService } from './perfil.service';

@Controller('perfil')
@UseGuards(JwtGuard)
export class PerfilController {
  constructor(private service: PerfilService) {}

  @Get()
  get(@Req() req: any) {
    return this.service.getMeuPerfil(req.userId);
  }

  @Patch()
  update(
    @Req() req: any,
    @Body() body: { name?: string; phone_e164?: string; address_json?: Record<string, any> },
  ) {
    return this.service.updateMeuPerfil(req.userId, body);
  }
}

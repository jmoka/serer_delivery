import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller('admin/usuarios')
@UseGuards(AdminGuard)
export class UsuariosController {
  constructor(private service: UsuariosService) {}

  @Get()
  listar(@Query() q: { busca?: string; role?: string; page?: string; limit?: string }) {
    return this.service.listar({
      busca: q.busca,
      role: q.role,
      page: Number(q.page) || 1,
      limit: Number(q.limit) || 50,
    });
  }

  @Get('auditoria')
  auditoria(@Query('usuario_id') usuarioId?: string) {
    return this.service.listarAuditoria(usuarioId);
  }

  @Patch(':id/credenciais')
  trocarCredenciais(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { email?: string; senha?: string },
  ) {
    return this.service.trocarCredenciais(req.userId, id, body);
  }
}

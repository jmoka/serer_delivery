import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { EnderecosService } from './enderecos.service';

@Controller('perfil/enderecos')
@UseGuards(JwtGuard)
export class EnderecosController {
  constructor(private service: EnderecosService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.userId);
  }

  @Post()
  criar(
    @Req() req: any,
    @Body() body: { apelido?: string; address_json: Record<string, any>; lat?: number; lng?: number; definirComoAtivo?: boolean },
  ) {
    return this.service.criar(req.userId, body);
  }

  @Patch(':id')
  editar(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { apelido?: string; address_json?: Record<string, any>; lat?: number; lng?: number },
  ) {
    return this.service.editar(req.userId, id, body);
  }

  @Delete(':id')
  excluir(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.excluir(req.userId, id);
  }

  @Post(':id/verificar')
  verificar(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.verificar(req.userId, id);
  }

  @Patch(':id/selecionar')
  selecionar(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { lat?: number; lng?: number }) {
    return this.service.selecionar(req.userId, id, body);
  }
}

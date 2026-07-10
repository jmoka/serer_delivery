import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { EmpresasService } from './empresas.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller('empresas')
@UseGuards(AdminGuard)
export class EmpresasController {
  constructor(private service: EmpresasService) {}

  @Get()
  listar() {
    return this.service.listar();
  }

  @Get(':id')
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
  }

  @Post()
  criar(@Body() body: {
    name: string;
    address?: string;
    logo_url?: string;
    comissao_pct?: number;
    user_id?: string;
  }) {
    return this.service.criar(body);
  }

  @Patch(':id')
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.service.atualizar(id, body);
  }

  @Patch(':id/bloquear')
  bloquear(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { bloqueado: boolean },
  ) {
    return this.service.bloquear(id, body.bloqueado);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }

  @Get(':id/config')
  getConfig(@Param('id', ParseIntPipe) id: number) {
    return this.service.getConfig(id);
  }

  @Patch(':id/config')
  updateConfig(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.updateConfig(id, body);
  }
}

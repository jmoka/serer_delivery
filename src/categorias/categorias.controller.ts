import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CategoriasService } from './categorias.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller()
export class CategoriasController {
  constructor(private service: CategoriasService) {}

  /** Público — listagem de categorias globais para home e cadastro de produtos */
  @Get('categorias/globais')
  listarGlobais() {
    return this.service.listarGlobais();
  }

  /** Admin — CRUD de categorias globais */
  @Post('categorias/globais')
  @UseGuards(AdminGuard)
  criarGlobal(@Body() body: { name: string; icon_name: string; color_primary: string; color_secondary: string }) {
    return this.service.criarGlobal(body);
  }

  @Patch('categorias/globais/:id')
  @UseGuards(AdminGuard)
  atualizarGlobal(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; icon_name?: string; color_primary?: string; color_secondary?: string },
  ) {
    return this.service.atualizarGlobal(id, body);
  }

  @Delete('categorias/globais/:id')
  @UseGuards(AdminGuard)
  removerGlobal(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }

  /** Admin — categorias por empresa */
  @Get('empresas/:empresaId/categorias')
  @UseGuards(AdminGuard)
  listar(@Param('empresaId', ParseIntPipe) empresaId: number) {
    return this.service.listarPorEmpresa(empresaId);
  }

  @Post('categorias')
  @UseGuards(AdminGuard)
  criar(@Body() body: { name: string; restaurant_id: number }) {
    return this.service.criar(body);
  }

  @Patch('categorias/:id')
  @UseGuards(AdminGuard)
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ) {
    return this.service.atualizar(id, body);
  }

  @Delete('categorias/:id')
  @UseGuards(AdminGuard)
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }
}

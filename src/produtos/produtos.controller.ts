import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProdutosService } from './produtos.service';
import { AdminGuard } from '../auth/admin.guard';

@Controller()
@UseGuards(AdminGuard)
export class ProdutosController {
  constructor(private service: ProdutosService) {}

  @Get('empresas/:empresaId/produtos')
  listar(
    @Param('empresaId', ParseIntPipe) empresaId: number,
    @Query('apenas_ativos') apenasAtivos?: string,
  ) {
    return this.service.listarPorEmpresa(empresaId, apenasAtivos === 'true');
  }

  @Get('produtos/:id')
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
  }

  @Post('produtos')
  criar(@Body() body: {
    name: string;
    description?: string;
    price: number;
    image_url?: string;
    category_id: number;
  }) {
    return this.service.criar(body);
  }

  @Patch('produtos/:id')
  atualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.service.atualizar(id, body);
  }

  @Patch('produtos/:id/toggle')
  toggle(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { ativo: boolean },
  ) {
    return this.service.toggleAtivo(id, body.ativo);
  }

  @Delete('produtos/:id')
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.remover(id);
  }
}

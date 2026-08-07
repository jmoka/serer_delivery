import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { AdminGuard } from '../auth/admin.guard';
import { CriarPlanoDto } from './dto/criar-plano.dto';
import { AtualizarPlanoDto } from './dto/atualizar-plano.dto';
import { AtribuirAssinaturaDto } from './dto/atribuir-assinatura.dto';

@Controller('planos')
@UseGuards(AdminGuard)
export class PlanosAdminController {
  constructor(private service: PlanosService) {}

  // Rotas fixas precisam vir antes de ":id" pra não colidir com o parser de rota
  @Get('assinaturas')
  listarAssinaturas() {
    return this.service.listarAssinaturas();
  }

  @Get('assinaturas/:restaurantId')
  buscarAssinatura(@Param('restaurantId', ParseIntPipe) restaurantId: number) {
    return this.service.buscarAssinaturaPorRestaurante(restaurantId);
  }

  @Put('assinaturas/:restaurantId')
  atribuirAssinatura(
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Body() body: AtribuirAssinaturaDto,
  ) {
    return this.service.atribuirAssinatura({ restaurantId }, body.plano_id);
  }

  @Patch('assinaturas/:restaurantId/cancelar')
  cancelarAssinatura(@Param('restaurantId', ParseIntPipe) restaurantId: number) {
    return this.service.cancelarAssinatura({ restaurantId });
  }

  @Post('assinaturas/:restaurantId/gerar-fatura')
  gerarFaturaManual(@Param('restaurantId', ParseIntPipe) restaurantId: number) {
    return this.service.gerarFaturaManual(restaurantId);
  }

  @Get('faturas')
  listarFaturas(
    @Query('restaurant_id') restaurantId?: string,
    @Query('status') status?: string,
    @Query('tipo') tipo?: 'saas' | 'local',
  ) {
    return this.service.listarFaturas({
      restaurant_id: restaurantId ? parseInt(restaurantId, 10) : undefined,
      status,
      tipo,
    });
  }

  @Patch('faturas/:id/marcar-paga')
  marcarFaturaPaga(@Param('id', ParseIntPipe) id: number) {
    return this.service.marcarFaturaPaga(id);
  }

  @Get()
  listar() {
    return this.service.listarPlanos();
  }

  @Get(':id')
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscarPlano(id);
  }

  @Post()
  criar(@Body() body: CriarPlanoDto) {
    return this.service.criarPlano(body);
  }

  @Patch(':id')
  atualizar(@Param('id', ParseIntPipe) id: number, @Body() body: AtualizarPlanoDto) {
    return this.service.atualizarPlano(id, body);
  }

  @Delete(':id')
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.removerPlano(id);
  }
}

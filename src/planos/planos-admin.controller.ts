import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { AdminGuard } from '../auth/admin.guard';
import { CriarPlanoDto } from './dto/criar-plano.dto';
import { AtualizarPlanoDto } from './dto/atualizar-plano.dto';
import { AtribuirAssinaturaDto } from './dto/atribuir-assinatura.dto';
import { AtualizarCortesiaDto } from './dto/atualizar-cortesia.dto';
import { CriarFaturaManualDto } from './dto/criar-fatura-manual.dto';
import { AtualizarFaturaDto } from './dto/atualizar-fatura.dto';

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
    return this.service.atribuirAssinatura({ restaurantId }, body.plano_id, body.cortesia_ate);
  }

  // Edita só a data de cortesia ("grátis até") sem trocar de plano/reiniciar o
  // ciclo de trial — "grátis eterno" é o front mandando uma data ~50 anos à frente.
  @Patch('assinaturas/:restaurantId/cortesia')
  atualizarCortesia(
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Body() body: AtualizarCortesiaDto,
  ) {
    return this.service.atualizarCortesia(restaurantId, body.cortesia_ate ?? null);
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

  // Link público (sem login) pra admin copiar e mandar pro cliente pagar —
  // resolvido em PlanosPublicoController (GET /fatura-pagamento/:token).
  @Post('faturas/:id/gerar-link')
  gerarLinkPagamento(@Param('id', ParseIntPipe) id: number) {
    return this.service.gerarLinkPagamento(id);
  }

  @Post('faturas')
  criarFaturaManual(@Body() body: CriarFaturaManualDto) {
    return this.service.criarFaturaManual(body);
  }

  @Patch('faturas/:id')
  atualizarFatura(@Param('id', ParseIntPipe) id: number, @Body() body: AtualizarFaturaDto) {
    return this.service.atualizarFatura(id, body);
  }

  @Patch('faturas/:id/cancelar')
  cancelarFatura(@Param('id', ParseIntPipe) id: number) {
    return this.service.cancelarFatura(id);
  }

  @Delete('faturas/:id')
  removerFatura(@Param('id', ParseIntPipe) id: number) {
    return this.service.removerFatura(id);
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

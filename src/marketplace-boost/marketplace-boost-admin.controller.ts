import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { MarketplaceBoostService } from './marketplace-boost.service';
import { CriarPacoteDto } from './dto/criar-pacote.dto';
import { AtualizarPacoteDto } from './dto/atualizar-pacote.dto';
import { CriarBoostDto } from './dto/criar-boost.dto';

@Controller('marketplace-boost')
@UseGuards(AdminGuard)
export class MarketplaceBoostAdminController {
  constructor(private service: MarketplaceBoostService) {}

  @Get('carrosseis')
  carrosseis() {
    return this.service.listarCarrosseisDisponiveis();
  }

  @Get('vagas')
  vagas() {
    return this.service.vagasConfiguradas();
  }

  @Put('vagas')
  salvarVagas(@Body() body: Record<string, number>) {
    return this.service.salvarVagas(body);
  }

  @Get('vagas/presets')
  listarPresetsVagas() {
    return this.service.listarPresetsVagas();
  }

  @Post('vagas/presets')
  criarPresetVagas(@Body() body: { nome: string; config: Record<string, number> }) {
    return this.service.criarPresetVagas(body.nome, body.config);
  }

  @Post('vagas/presets/:id/aplicar')
  aplicarPresetVagas(@Param('id', ParseIntPipe) id: number) {
    return this.service.aplicarPresetVagas(id);
  }

  @Delete('vagas/presets/:id')
  removerPresetVagas(@Param('id', ParseIntPipe) id: number) {
    return this.service.removerPresetVagas(id);
  }

  @Get('pacotes')
  listar() {
    return this.service.listarPacotesAdmin();
  }

  @Post('pacotes')
  criar(@Body() body: CriarPacoteDto) {
    return this.service.criarPacote(body);
  }

  @Patch('pacotes/:id')
  atualizar(@Param('id', ParseIntPipe) id: number, @Body() body: AtualizarPacoteDto) {
    return this.service.atualizarPacote(id, body);
  }

  @Delete('pacotes/:id')
  remover(@Param('id', ParseIntPipe) id: number) {
    return this.service.removerPacote(id);
  }

  // Mesma visão enriquecida (composição + vagas restantes) que o dono vê em
  // /restaurante/boosts/pacotes — o admin precisa saber o que ainda cabe
  // comprar antes de conceder uma campanha em nome de uma empresa.
  @Get('pacotes-disponiveis')
  pacotesDisponiveis() {
    return this.service.listarPacotesDisponiveis();
  }

  // ── Conceder/gerir campanhas em nome de uma empresa específica ──

  @Get('empresas/:restaurantId/boosts')
  listarBoostsEmpresa(@Param('restaurantId', ParseIntPipe) restaurantId: number) {
    return this.service.meusBoosts(restaurantId);
  }

  @Get('empresas/:restaurantId/itens/:carrossel')
  listarItensEmpresa(
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Param('carrossel') carrossel: string,
  ) {
    return this.service.listarItensVendaveis(restaurantId, carrossel);
  }

  // Admin concede a campanha diretamente (cortesia/venda manual) — nasce já
  // paga, sem passar pelo PagBank.
  @Post('empresas/:restaurantId/boosts')
  criarBoostEmpresa(
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Body() body: CriarBoostDto,
  ) {
    return this.service.criarBoost(restaurantId, body.pacote_id, body.itens, { cortesiaAdmin: true });
  }

  @Patch('boosts/:id/encerrar')
  encerrarBoost(@Param('id', ParseIntPipe) id: number) {
    return this.service.encerrarBoost(id);
  }

  @Delete('boosts/:id')
  removerBoostNaoPago(@Param('id', ParseIntPipe) id: number) {
    return this.service.removerBoostNaoPago(id);
  }
}

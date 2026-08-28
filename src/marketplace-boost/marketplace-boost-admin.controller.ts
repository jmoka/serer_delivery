import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { MarketplaceBoostService } from './marketplace-boost.service';
import { CriarPacoteDto } from './dto/criar-pacote.dto';
import { AtualizarPacoteDto } from './dto/atualizar-pacote.dto';

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
}

import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { InstalacoesService } from './instalacoes.service';
import { AdminGuard } from '../auth/admin.guard';
import { CriarInstalacaoDto } from './dto/criar-instalacao.dto';
import { AtualizarInstalacaoDto } from './dto/atualizar-instalacao.dto';
import { AtribuirPlanoInstalacaoDto } from './dto/atribuir-plano-instalacao.dto';

@Controller('instalacoes')
@UseGuards(AdminGuard)
export class InstalacoesAdminController {
  constructor(private service: InstalacoesService) {}

  @Get()
  listar() {
    return this.service.listar();
  }

  @Get(':id')
  detalhe(@Param('id', ParseIntPipe) id: number) {
    return this.service.detalheComFaturas(id);
  }

  @Post()
  criar(@Body() body: CriarInstalacaoDto) {
    return this.service.criar(body);
  }

  @Patch(':id')
  atualizar(@Param('id', ParseIntPipe) id: number, @Body() body: AtualizarInstalacaoDto) {
    return this.service.atualizar(id, body);
  }

  @Post(':id/plano')
  atribuirPlano(@Param('id', ParseIntPipe) id: number, @Body() body: AtribuirPlanoInstalacaoDto) {
    return this.service.atribuirPlano(id, body.plano_id);
  }

  @Post(':id/gerar-fatura')
  gerarFaturaManual(@Param('id', ParseIntPipe) id: number) {
    return this.service.gerarFaturaManual(id);
  }
}

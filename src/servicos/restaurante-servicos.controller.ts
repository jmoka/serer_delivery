import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RestaurantOwnerGuard } from '../auth/restaurant-owner.guard';
import { ServicosService } from './servicos.service';
import { CriarServicoDto } from './dto/criar-servico.dto';
import { EditarServicoDto } from './dto/editar-servico.dto';

@Controller('restaurante/servicos')
@UseGuards(RestaurantOwnerGuard)
export class RestauranteServicosController {
  constructor(private service: ServicosService) {}

  @Get()
  listar(@Req() req: any) {
    return this.service.listarMeusServicos(req.restaurantId);
  }

  @Post()
  criar(@Body() body: CriarServicoDto, @Req() req: any) {
    return this.service.criarServico(req.restaurantId, body);
  }

  @Patch(':id')
  editar(@Param('id', ParseIntPipe) id: number, @Body() body: EditarServicoDto, @Req() req: any) {
    return this.service.editarServico(id, req.restaurantId, body);
  }

  @Delete(':id')
  deletar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.deletarServico(id, req.restaurantId);
  }

  @Patch(':id/toggle')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: { ativo: boolean }, @Req() req: any) {
    return this.service.toggleServico(id, req.restaurantId, !!body?.ativo);
  }

  @Get('solicitacoes/count')
  solicitacoesCount(@Req() req: any) {
    return this.service.contarSolicitacoesPendentes(req.restaurantId);
  }

  @Get('solicitacoes')
  solicitacoes(@Query('status') status: 'pendente' | 'contatado' | undefined, @Req() req: any) {
    return this.service.listarSolicitacoes(req.restaurantId, status);
  }

  @Patch('solicitacoes/:id/contatado')
  marcarContatado(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.marcarComoContatado(id, req.restaurantId);
  }
}

import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AgenteGdoorGuard } from '../auth/agente-gdoor.guard';
import { GdoorService } from './gdoor.service';

// API consumida pelo agente Python local (api_gdoor) — token de pareamento
// (x-gdoor-agente-token), não usa Supabase Auth nem sessão de dono.
@Controller('agente-gdoor')
@UseGuards(AgenteGdoorGuard)
export class AgenteGdoorController {
  constructor(private service: GdoorService) {}

  @Get('me')
  me(@Req() req: any) {
    return { restaurante: { id: req.agenteRestaurantId, name: req.agenteRestaurantName } };
  }

  @Post('cnpj')
  registrarCnpj(@Body() body: { cnpj: string }, @Req() req: any) {
    return this.service.registrarCnpjAgente(req.agenteRestaurantId, body.cnpj);
  }

  // Catálogo do ESTOQUE local, reportado a cada poll — só alimenta o seletor de
  // código no painel, não é usado pelo agente pra decidir mapeamento nenhum.
  @Post('estoque')
  registrarEstoque(@Body() body: { itens: { codigo: string; descricao?: string; preco_venda?: number; qtd?: number; unidade?: string }[] }, @Req() req: any) {
    return this.service.registrarEstoque(req.agenteRestaurantId, body.itens ?? []);
  }

  @Get('jobs/pendentes')
  jobsPendentes(@Req() req: any) {
    return this.service.jobsPendentes(req.agenteRestaurantId, req.agenteCnpjEsperado, req.agenteCnpjConfirmado);
  }

  @Post('jobs/:id/concluido')
  marcarProcessado(@Param('id', ParseIntPipe) id: number, @Body() body: { venda_id_gdoor?: string }, @Req() req: any) {
    return this.service.marcarProcessado(id, req.agenteRestaurantId, body.venda_id_gdoor ?? '');
  }

  @Post('jobs/:id/erro')
  marcarErro(@Param('id', ParseIntPipe) id: number, @Body() body: { mensagem?: string }, @Req() req: any) {
    return this.service.marcarErro(id, req.agenteRestaurantId, body.mensagem ?? 'Erro desconhecido');
  }

  @Get('criar-produto/pendentes')
  criarProdutoPendentes(@Req() req: any) {
    return this.service.criarProdutoPendentes(req.agenteRestaurantId, req.agenteCnpjEsperado, req.agenteCnpjConfirmado);
  }

  @Post('criar-produto/:id/concluido')
  marcarProdutoCriado(@Param('id', ParseIntPipe) id: number, @Body() body: { codigo_gdoor: string }, @Req() req: any) {
    return this.service.marcarProdutoCriado(id, req.agenteRestaurantId, body.codigo_gdoor);
  }

  @Post('criar-produto/:id/erro')
  marcarProdutoErro(@Param('id', ParseIntPipe) id: number, @Body() body: { mensagem?: string }, @Req() req: any) {
    return this.service.marcarProdutoErro(id, req.agenteRestaurantId, body.mensagem ?? 'Erro desconhecido');
  }

  // Catálogo de clientes local, reportado a cada poll — mesmo padrão do estoque.
  @Post('clientes')
  registrarClientes(@Body() body: { itens: any[] }, @Req() req: any) {
    return this.service.registrarClientes(req.agenteRestaurantId, body.itens ?? []);
  }

  @Get('criar-cliente/pendentes')
  criarClientePendentes(@Req() req: any) {
    return this.service.criarClientePendentes(req.agenteRestaurantId, req.agenteCnpjEsperado, req.agenteCnpjConfirmado);
  }

  @Post('criar-cliente/:id/concluido')
  marcarClienteCriado(@Param('id', ParseIntPipe) id: number, @Body() body: { codigo_gdoor: string }, @Req() req: any) {
    return this.service.marcarClienteCriado(id, req.agenteRestaurantId, body.codigo_gdoor);
  }

  @Post('criar-cliente/:id/erro')
  marcarClienteErro(@Param('id', ParseIntPipe) id: number, @Body() body: { mensagem?: string }, @Req() req: any) {
    return this.service.marcarClienteErro(id, req.agenteRestaurantId, body.mensagem ?? 'Erro desconhecido');
  }
}

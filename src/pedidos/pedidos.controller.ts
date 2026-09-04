import {
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { PedidosService } from './pedidos.service';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('pedidos')
export class PedidosController {
  constructor(private service: PedidosService) {}

  // Admin: lista todos (com filtros)
  @Get()
  @UseGuards(AdminGuard)
  listar(
    @Query('empresa_id') empresaId?: string,
    @Query('status') status?: string,
    @Query('data_inicio') dataInicio?: string,
    @Query('data_fim') dataFim?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.listar({
      empresa_id: empresaId ? parseInt(empresaId) : undefined,
      status,
      data_inicio: dataInicio,
      data_fim: dataFim,
      limite: limite ? parseInt(limite) : undefined,
    });
  }

  // Cliente: seus próprios pedidos
  @Get('meus')
  @UseGuards(JwtGuard)
  meusPedidos(@Req() req: any, @Query('limite') limite?: string) {
    return this.service.listar({
      user_id: req.userId,
      limite: limite ? parseInt(limite) : 20,
    });
  }

  // Preview do excedente de km antes de confirmar o pedido (StepEndereco em diante do
  // checkout) — precisa vir ANTES de @Get(':id') senão o Nest casaria como :id.
  @Get('estimativa-frete')
  @UseGuards(JwtGuard)
  estimativaFrete(@Query('restaurant_id', ParseIntPipe) restaurantId: number, @Req() req: any) {
    return this.service.estimarFrete(req.userId, restaurantId);
  }

  // Preview em tempo real enquanto o cliente ainda está digitando o endereço
  // (antes de salvar o perfil) — StepEndereco chama isso assim que o CEP resolve.
  @Post('estimativa-frete-endereco')
  @UseGuards(JwtGuard)
  estimativaFreteEndereco(@Body() body: { restaurant_id: number; address_json: Record<string, string> }) {
    return this.service.estimarFretePorEndereco(body.restaurant_id, body.address_json ?? {});
  }

  // Recalcula com a coordenada que o cliente confirmou/ajustou arrastando o pino no
  // mapa — usado quando a geocodificação automática erra (ex: rua com nome duplicado
  // em outro bairro da cidade).
  @Post('estimativa-frete-pino')
  @UseGuards(JwtGuard)
  estimativaFretePino(@Body() body: { restaurant_id: number; lat: number; lng: number }) {
    return this.service.estimarFretePorCoordenada(body.restaurant_id, body.lat, body.lng);
  }

  // Admin ou dono do pedido
  @Get(':id')
  @UseGuards(JwtGuard)
  buscar(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.buscar(id, req.userId, req.userRole);
  }

  // Cliente autenticado cria pedido
  @Post()
  @UseGuards(JwtGuard)
  criar(
    @Body() body: {
      restaurant_id: number;
      customer_id?: number;
      payment_method: string;
      troco_para?: number;
      itens: { product_id: number; quantity: number }[];
      retirada_balcao?: boolean;
    },
    @Req() req: any,
  ) {
    return this.service.criar({ ...body, user_id: req.userId });
  }

  // Admin atualiza status
  @Patch(':id/status')
  @UseGuards(AdminGuard)
  atualizarStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
  ) {
    return this.service.atualizarStatus(id, body.status as any);
  }

  // Cliente cancela antes do preparo (pending ou confirmed)
  @Patch(':id/cancelar')
  @UseGuards(JwtGuard)
  cancelarCliente(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { motivo: string },
    @Req() req: any,
  ) {
    return this.service.cancelarCliente(id, req.userId, body.motivo);
  }

  // Admin cancela
  @Delete(':id')
  @UseGuards(AdminGuard)
  cancelar(@Param('id', ParseIntPipe) id: number) {
    return this.service.cancelar(id);
  }

  // Cliente anexa comprovante do PIX manual (foto tirada no checkout)
  @Post(':id/comprovante')
  @UseGuards(JwtGuard)
  uploadComprovante(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { base64: string },
    @Req() req: any,
  ) {
    return this.service.uploadComprovanteCliente(id, req.userId, body.base64);
  }

  // Cliente escolhe pular o anexo agora e avisa que vai mostrar/pagar em pessoa
  @Patch(':id/pular-comprovante')
  @UseGuards(JwtGuard)
  pularComprovante(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.pularComprovante(id, req.userId);
  }
}

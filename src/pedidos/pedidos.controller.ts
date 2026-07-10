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

  // Admin ou dono do pedido
  @Get(':id')
  @UseGuards(JwtGuard)
  buscar(@Param('id', ParseIntPipe) id: number) {
    return this.service.buscar(id);
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
    },
    @Req() req: any,
  ) {
    return this.service.criar({ ...body, user_id: req.userId });
  }

  // Admin atualiza status (trigger DB registra comissão ao delivered)
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
}

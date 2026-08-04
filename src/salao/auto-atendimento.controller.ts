import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AutoAtendimentoService } from './auto-atendimento.service';
import { ItemComandaBody } from './salao.service';

// Rota pública (sem login) — cliente escaneia o QR fixo da mesa e pede direto,
// sem depender do garçom. Ver auto-atendimento.service.ts pro mecanismo de sessão.
@Controller('auto-atendimento')
export class AutoAtendimentoController {
  constructor(private service: AutoAtendimentoService) {}

  @Post(':mesaToken/entrar')
  entrar(@Param('mesaToken') mesaToken: string) {
    return this.service.entrar(mesaToken);
  }

  @Get(':mesaToken/comanda')
  obterComanda(@Param('mesaToken') mesaToken: string, @Query('sessionId') sessionId: string) {
    return this.service.obterComanda(mesaToken, sessionId);
  }

  @Post(':mesaToken/itens')
  adicionarItens(
    @Param('mesaToken') mesaToken: string,
    @Body() body: { sessionId: string; itens: ItemComandaBody[] },
  ) {
    return this.service.adicionarItens(mesaToken, body.sessionId, body.itens);
  }

  @Delete(':mesaToken/itens/:itemId')
  removerItem(
    @Param('mesaToken') mesaToken: string,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Query('sessionId') sessionId: string,
  ) {
    return this.service.removerItem(mesaToken, sessionId, itemId);
  }

  @Post(':mesaToken/solicitar-pedido')
  solicitarPedido(@Param('mesaToken') mesaToken: string, @Body() body: { sessionId: string }) {
    return this.service.solicitarPedido(mesaToken, body.sessionId);
  }

  @Post(':mesaToken/gorjeta')
  definirGorjeta(@Param('mesaToken') mesaToken: string, @Body() body: { sessionId: string; semGorjeta: boolean }) {
    return this.service.definirGorjeta(mesaToken, body.sessionId, body.semGorjeta);
  }

  @Post(':mesaToken/solicitar-conferencia')
  solicitarConferencia(@Param('mesaToken') mesaToken: string, @Body() body: { sessionId: string }) {
    return this.service.solicitarConferencia(mesaToken, body.sessionId);
  }
}

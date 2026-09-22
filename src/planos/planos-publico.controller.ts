import { Controller, Get, Param } from '@nestjs/common';
import { PlanosService } from './planos.service';

// Sem guard, de propósito — link enviado pro cliente pagar a fatura sem login
// (ex.: WhatsApp). Token opaco (planos.service.ts gerarLinkPagamento), nunca
// o id sequencial da fatura — resposta só traz os campos necessários pra
// montar a tela de pagamento (ver buscarFaturaPublicaPorToken).
@Controller('fatura-pagamento')
export class PlanosPublicoController {
  constructor(private service: PlanosService) {}

  @Get(':token')
  buscar(@Param('token') token: string) {
    return this.service.buscarFaturaPublicaPorToken(token);
  }
}

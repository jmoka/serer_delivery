import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PlanosService } from './planos.service';
import { PagarFaturaDto } from './dto/pagar-fatura.dto';

// Sem guard, de propósito — link enviado pro cliente pagar a fatura sem login
// (ex.: WhatsApp). Token opaco (planos.service.ts gerarLinkPagamento), nunca
// o id sequencial da fatura — resposta só traz os campos necessários pra
// montar a tela de pagamento (ver buscarFaturaPublicaPorToken).
@Controller('fatura-pagamento')
export class PlanosPublicoController {
  constructor(private service: PlanosService) {}

  // Rota estática antes de ':token' — senão o Nest casaria essa palavra como token.
  @Get('pagbank-chave-publica')
  chavePublica() {
    return this.service.buscarChavePublicaCartao();
  }

  @Get(':token')
  buscar(@Param('token') token: string) {
    return this.service.buscarFaturaPublicaPorToken(token);
  }

  // Abre ordem real no PagBank (Pix ou cartão) em nome da plataforma — mesmo
  // fluxo de pagarFatura, só que resolvido pelo token em vez de req.restaurantId.
  @Post(':token/pagar')
  pagar(@Param('token') token: string, @Body() body: PagarFaturaDto) {
    return this.service.pagarFaturaPublica(token, body);
  }
}

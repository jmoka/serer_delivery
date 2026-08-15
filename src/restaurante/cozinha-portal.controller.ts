import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { CozinhaGuard } from '../auth/cozinha.guard';
import { RestauranteService } from './restaurante.service';
import { ImpressorasService } from '../salao/impressoras.service';

@Controller('cozinha-portal')
@UseGuards(CozinhaGuard)
export class CozinhaPortalController {
  constructor(
    private service: RestauranteService,
    private impressoras: ImpressorasService,
  ) {}

  @Get('me')
  me(@Req() req: any) {
    return { restaurante: { id: req.cozinhaRestaurantId, name: req.cozinhaRestaurantName } };
  }

  // Resgate de token: chamado uma vez, logo depois que a tela abre com o token
  // vindo de um link/QR code compartilhado (ver F2 da auditoria de segurança —
  // token na URL fica exposto em histórico/QR fotografado). CozinhaGuard já
  // validou o token atual pra deixar chegar aqui; a resposta troca esse token
  // por um novo e invalida o antigo na mesma tacada — o link original só serve
  // pra um resgate, depois disso quem tiver copiado/fotografado a URL antiga
  // não consegue mais nada com ela.
  @Post('resgatar-token')
  async resgatarToken(@Req() req: any) {
    if (req.cozinhaImpressoraId) {
      const { token } = await this.impressoras.renovarToken(req.cozinhaImpressoraId, req.cozinhaRestaurantId);
      return { token };
    }
    const { cozinha_token } = await this.service.renovarTokenCozinha(req.cozinhaRestaurantId);
    return { token: cozinha_token };
  }

  @Get('pedidos')
  pedidos(@Req() req: any) {
    return this.service.getCozinha(req.cozinhaRestaurantId);
  }

  @Patch('pedidos/:id/status')
  atualizarStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
    @Req() req: any,
  ) {
    return this.service.atualizarStatusPedido(id, req.cozinhaRestaurantId, body.status);
  }
}

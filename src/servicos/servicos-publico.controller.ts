import { Body, Controller, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupabaseService } from '../supabase/supabase.service';
import { ServicosService } from './servicos.service';
import { SolicitarOrcamentoDto } from './dto/solicitar-orcamento.dto';

// Vitrine pública — cliente pede orçamento sem login. Mutação, por isso fica
// fora do CatalogoController (que só monta payload cacheado de leitura).
@Controller('r/:slug/servicos')
export class ServicosPublicoController {
  constructor(
    private supabase: SupabaseService,
    private service: ServicosService,
  ) {}

  private async resolverRestaurantId(slug: string): Promise<number> {
    const { data } = await this.supabase.client
      .from('restaurants').select('id, modulo_servicos').eq('slug', slug).maybeSingle();
    if (!data || !data.modulo_servicos) throw new NotFoundException('Restaurante não encontrado');
    return data.id;
  }

  @Post(':servicoId/solicitar-orcamento')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async solicitarOrcamento(
    @Param('slug') slug: string,
    @Param('servicoId', ParseIntPipe) servicoId: number,
    @Body() body: SolicitarOrcamentoDto,
  ) {
    const restaurantId = await this.resolverRestaurantId(slug);
    return this.service.criarSolicitacaoOrcamento(restaurantId, servicoId, body);
  }
}

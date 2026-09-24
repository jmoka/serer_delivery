import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// Campos crus de frete embutido carregados do produto — resolvidos pra um
// valor em R$ só depois (ver resolverFreteEmbutidoUnitario), porque o modo
// 'km' depende da distância do pedido inteiro, calculada mais tarde em
// PedidosService.criar(). Não usa nem mistura com motoboy_comissao_* do
// restaurante (lógica geral) — cada produto tem a própria config, individual.
export interface FreteEmbutidoConfig {
  frete_embutido?: boolean | null;
  frete_embutido_tipo?: string | null;
  frete_embutido_valor_fixo?: number | null;
  frete_embutido_percentual?: number | null;
  frete_embutido_valor_km?: number | null;
  frete_embutido_km_fallback?: number | null;
}

export interface ItemExpandido extends FreteEmbutidoConfig {
  product_id: number;
  quantity: number;
  unit_price: number;
  combo_nome?: string;
  combo_quantidade?: number;
  frete_embutido_unitario?: number | null;
}

// Resolve o valor de frete embutido no preço, no momento da venda — nunca
// recalculado depois (mesmo princípio de snapshot do unit_price). Puramente
// bookkeeping interno da loja: nunca muda o preço cobrado do cliente nem a
// comissão da plataforma, que continuam incidindo sobre precoBase cheio.
// distanciaKm vem do pedido inteiro (mesma distância já calculada pro
// excedente de km do frete do motoboy) — null quando é retirada no balcão.
export function resolverFreteEmbutidoUnitario(
  config: FreteEmbutidoConfig,
  precoBase: number,
  distanciaKm: number | null,
): number | null {
  if (!config.frete_embutido) return null;
  if (config.frete_embutido_tipo === 'percentual') {
    if (config.frete_embutido_percentual == null) return null;
    return Math.round(precoBase * (config.frete_embutido_percentual / 100) * 100) / 100;
  }
  if (config.frete_embutido_tipo === 'km') {
    if (distanciaKm != null && config.frete_embutido_valor_km != null) {
      return Math.round(distanciaKm * config.frete_embutido_valor_km * 100) / 100;
    }
    return config.frete_embutido_km_fallback ?? null;
  }
  return config.frete_embutido_valor_fixo ?? null;
}

@Injectable()
export class CombosService {
  constructor(private supabase: SupabaseService) {}

  // Combo só fica disponível pra venda se ele mesmo estiver ativo E todos os produtos
  // que o compõem tiverem estoque > 0 — se faltar 1 ingrediente, o combo some da
  // venda igual um produto avulso zerado (mesma regra de deliveryhub_estoque_zero_bloqueia_venda).
  // Não filtra a linha fora — devolve `disponivel` pro chamador decidir (endpoint de
  // venda exclui, tela de gestão do dono mostra tudo com um aviso).
  async listarComDisponibilidade(restaurantId: number) {
    const { data, error } = await this.supabase.client
      .from('combos')
      .select(
        'id, name, description, price, preco_promo, image_url, is_active, destaque, created_at, combo_items(quantity, products(quantidade_estoque, is_active))',
      )
      .eq('restaurant_id', restaurantId)
      .order('destaque', { ascending: false })
      .order('name');
    if (error) throw error;

    return (data ?? []).map((c: any) => {
      const { combo_items, ...resto } = c;
      const itens = combo_items ?? [];
      const disponivel =
        c.is_active &&
        itens.length > 0 &&
        itens.every((ci: any) => ci.products?.is_active && (ci.products?.quantidade_estoque ?? 0) > 0);
      return { ...resto, disponivel };
    });
  }

  // Combo não é uma entidade vendável própria no pedido — vira várias linhas dos
  // produtos reais que o compõem (order_items continua só sabendo de products,
  // então estoque/KDS/impressão por setor funcionam sem mudar nada). O preço de
  // cada linha é o `preco_no_combo` que o dono escolheu pra aquele produto
  // especificamente (definido no cadastro do combo, não é mais um fator único).
  async expandir(comboId: number, quantidadeComprada: number, restaurantId: number): Promise<ItemExpandido[]> {
    if (quantidadeComprada < 1) throw new BadRequestException('Quantidade do combo inválida');

    const { data: combo } = await this.supabase.client
      .from('combos')
      .select(
        'id, name, restaurant_id, is_active, combo_items(product_id, quantity, preco_no_combo, products(price, is_active, quantidade_estoque, frete_embutido, frete_embutido_tipo, frete_embutido_valor_fixo, frete_embutido_percentual, frete_embutido_valor_km, frete_embutido_km_fallback))',
      )
      .eq('id', comboId)
      .maybeSingle();

    if (!combo || combo.restaurant_id !== restaurantId) throw new NotFoundException(`Combo ${comboId} não encontrado`);
    if (!combo.is_active) throw new BadRequestException(`Combo ${comboId} não está disponível`);

    const itens = ((combo as any).combo_items ?? []) as Array<{
      product_id: number;
      quantity: number;
      preco_no_combo: number | null;
      products: ({
        price: number; is_active: boolean; quantidade_estoque: number;
      } & FreteEmbutidoConfig) | null;
    }>;
    if (!itens.length) throw new BadRequestException(`Combo ${comboId} não tem itens configurados`);

    // Não confia só no filtro da listagem (Zero Trust) — revalida estoque na hora da
    // compra, senão dois garçons podem vender o mesmo último ingrediente em paralelo.
    for (const it of itens) {
      if (!it.products) throw new BadRequestException(`Produto do combo ${comboId} não encontrado`);
      if (!it.products.is_active) throw new BadRequestException(`Um dos produtos do combo "${combo.name}" está indisponível`);
      if ((it.products.quantidade_estoque ?? 0) <= 0) {
        throw new BadRequestException(`Combo "${combo.name}" sem estoque — falta um dos ingredientes`);
      }
    }

    return itens.map((it) => {
      const unitPrice = it.preco_no_combo ?? it.products!.price;
      // Combo não tem override de frete próprio (só de preço, via preco_no_combo)
      // — usa direto a config do produto. Ainda não resolve pro valor final:
      // depende da distância do pedido, calculada só depois em PedidosService.
      return {
        product_id: it.product_id,
        quantity: it.quantity * quantidadeComprada,
        unit_price: unitPrice,
        combo_nome: combo.name,
        combo_quantidade: quantidadeComprada,
        frete_embutido: it.products!.frete_embutido,
        frete_embutido_tipo: it.products!.frete_embutido_tipo,
        frete_embutido_valor_fixo: it.products!.frete_embutido_valor_fixo,
        frete_embutido_percentual: it.products!.frete_embutido_percentual,
        frete_embutido_valor_km: it.products!.frete_embutido_valor_km,
        frete_embutido_km_fallback: it.products!.frete_embutido_km_fallback,
      };
    });
  }
}

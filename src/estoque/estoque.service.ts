import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface ItemEstoque {
  product_id: number;
  quantity: number;
}

@Injectable()
export class EstoqueService {
  constructor(private supabase: SupabaseService) {}

  // Ajuste atômico via função Postgres (um UPDATE só, sem corrida entre vendas
  // simultâneas). Nunca deixa negativo — ver migration ajustar_estoque_function.
  private async ajustar(productId: number, delta: number) {
    if (!delta) return;
    const { error } = await this.supabase.client.rpc('ajustar_estoque', {
      p_product_id: productId,
      p_delta: delta,
    });
    if (error) throw error;
  }

  // Venda nova (pedido delivery criado, item incluído na comanda) — desconta.
  async decrementarItens(itens: ItemEstoque[]) {
    await Promise.all(itens.map((i) => this.ajustar(i.product_id, -i.quantity)));
  }

  // Cancelamento (pedido, comanda, item) ou remoção de item ainda não enviado — devolve.
  async restaurarItens(itens: ItemEstoque[]) {
    await Promise.all(itens.map((i) => this.ajustar(i.product_id, i.quantity)));
  }

  // Edição de quantidade de um item já lançado — ajusta só a diferença.
  async ajustarPorDelta(productId: number, quantidadeAntiga: number, quantidadeNova: number) {
    await this.ajustar(productId, quantidadeAntiga - quantidadeNova);
  }

  // Restaura o estoque de todos os itens de um pedido/comanda ainda não cancelados
  // — usado quando o pedido/comanda inteiro é cancelado (não item a item).
  async restaurarItensDoPedido(orderId: number) {
    const { data: itens, error } = await this.supabase.client
      .from('order_items')
      .select('product_id, quantity')
      .eq('order_id', orderId)
      .neq('status', 'cancelado');
    if (error) throw error;
    if (!itens?.length) return;
    await this.restaurarItens(itens);
  }
}

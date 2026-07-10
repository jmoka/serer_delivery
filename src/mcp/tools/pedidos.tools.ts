import { SupabaseClient } from '@supabase/supabase-js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const pedidosToolDefinitions: Tool[] = [
  {
    name: 'listar_pedidos',
    description: 'Lista pedidos de uma empresa com filtros de status e período.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number' },
        status: {
          type: 'string',
          enum: ['pending', 'confirmed', 'ready', 'out_for_delivery', 'delivered', 'canceled'],
        },
        data_inicio: { type: 'string', description: 'YYYY-MM-DD' },
        data_fim: { type: 'string', description: 'YYYY-MM-DD' },
        limite: { type: 'number', description: 'Máximo de resultados (padrão: 50)' },
      },
      required: ['empresa_id'],
    },
  },
  {
    name: 'buscar_pedido',
    description: 'Detalhes completos de um pedido com itens e cliente.',
    inputSchema: {
      type: 'object',
      properties: {
        pedido_id: { type: 'number' },
      },
      required: ['pedido_id'],
    },
  },
  {
    name: 'estatisticas_pedidos',
    description: 'Estatísticas de pedidos por empresa: faturamento, ticket médio, cancelamentos.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number' },
        data_inicio: { type: 'string', description: 'YYYY-MM-DD' },
        data_fim: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['empresa_id'],
    },
  },
];

export async function executarPedidosTool(
  nome: string,
  args: Record<string, any>,
  supabase: SupabaseClient,
) {
  switch (nome) {
    case 'listar_pedidos': return listarPedidos(args, supabase);
    case 'buscar_pedido': return buscarPedido(args, supabase);
    case 'estatisticas_pedidos': return estatisticasPedidos(args, supabase);
    default: return null;
  }
}

async function listarPedidos(args: any, supabase: SupabaseClient) {
  let query = supabase
    .from('orders')
    .select('id, total, status, payment_method, created_at, customer_id')
    .eq('restaurant_id', args.empresa_id)
    .order('created_at', { ascending: false })
    .limit(args.limite ?? 50);

  if (args.status) query = query.eq('status', args.status);
  if (args.data_inicio) query = query.gte('created_at', args.data_inicio);
  if (args.data_fim) query = query.lte('created_at', args.data_fim + 'T23:59:59');

  const { data, error } = await query;
  if (error) throw error;
  return { pedidos: data, total: data?.length ?? 0 };
}

async function buscarPedido(args: any, supabase: SupabaseClient) {
  const { data: pedido, error } = await supabase
    .from('orders')
    .select('id, total, status, payment_method, created_at, restaurant_id, customer_id')
    .eq('id', args.pedido_id)
    .maybeSingle();

  if (error) throw error;
  if (!pedido) return { erro: 'Pedido não encontrado' };

  const { data: itens } = await supabase
    .from('order_items')
    .select('id, quantity, unit_price, product_id')
    .eq('order_id', args.pedido_id);

  const { data: cliente } = await supabase
    .from('customers')
    .select('id, name, email, phone_e164')
    .eq('id', pedido.customer_id)
    .maybeSingle();

  return { pedido, itens: itens ?? [], cliente };
}

async function estatisticasPedidos(args: any, supabase: SupabaseClient) {
  let query = supabase
    .from('orders')
    .select('id, total, status, created_at')
    .eq('restaurant_id', args.empresa_id);

  if (args.data_inicio) query = query.gte('created_at', args.data_inicio);
  if (args.data_fim) query = query.lte('created_at', args.data_fim + 'T23:59:59');

  const { data, error } = await query;
  if (error) throw error;

  const entregues = (data ?? []).filter((p) => p.status === 'delivered');
  const cancelados = (data ?? []).filter((p) => p.status === 'canceled');
  const faturamento = entregues.reduce((acc, p) => acc + (p.total ?? 0), 0);

  return {
    total_pedidos: data?.length ?? 0,
    entregues: entregues.length,
    cancelados: cancelados.length,
    faturamento,
    ticket_medio: entregues.length > 0 ? faturamento / entregues.length : 0,
  };
}

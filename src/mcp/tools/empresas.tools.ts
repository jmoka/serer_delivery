import { SupabaseClient } from '@supabase/supabase-js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const empresasToolDefinitions: Tool[] = [
  {
    name: 'listar_empresas',
    description: 'Lista todas as empresas (restaurantes/lojas) cadastradas na plataforma.',
    inputSchema: {
      type: 'object',
      properties: {
        ativo: { type: 'boolean', description: 'Filtrar por status ativo/inativo' },
      },
    },
  },
  {
    name: 'buscar_empresa',
    description: 'Detalhes de uma empresa específica com métricas de pedidos.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number' },
      },
      required: ['empresa_id'],
    },
  },
  {
    name: 'listar_comissoes',
    description: 'Lista comissões da plataforma por empresa em um período.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number', description: 'Filtrar por empresa específica' },
        data_inicio: { type: 'string', description: 'Data início (YYYY-MM-DD)' },
        data_fim: { type: 'string', description: 'Data fim (YYYY-MM-DD)' },
      },
    },
  },
];

export async function executarEmpresasTool(
  nome: string,
  args: Record<string, any>,
  supabase: SupabaseClient,
) {
  switch (nome) {
    case 'listar_empresas': return listarEmpresas(args, supabase);
    case 'buscar_empresa': return buscarEmpresa(args, supabase);
    case 'listar_comissoes': return listarComissoes(args, supabase);
    default: return null;
  }
}

async function listarEmpresas(args: any, supabase: SupabaseClient) {
  let query = supabase
    .from('restaurants')
    .select('id, name, address, created_at')
    .order('name');

  const { data, error } = await query;
  if (error) throw error;
  return { empresas: data, total: data?.length ?? 0 };
}

async function buscarEmpresa(args: any, supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('restaurants')
    .select('id, name, address, business_hours, payment_config, created_at')
    .eq('id', args.empresa_id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { erro: 'Empresa não encontrada' };

  const { data: pedidos } = await supabase
    .from('orders')
    .select('id, total, status, created_at')
    .eq('restaurant_id', args.empresa_id);

  const totalVendas = (pedidos ?? [])
    .filter((p) => p.status === 'delivered')
    .reduce((acc, p) => acc + (p.total ?? 0), 0);

  return {
    empresa: data,
    metricas: {
      total_pedidos: pedidos?.length ?? 0,
      total_vendas: totalVendas,
      pedidos_pendentes: (pedidos ?? []).filter((p) => p.status === 'pending').length,
    },
  };
}

async function listarComissoes(args: any, supabase: SupabaseClient) {
  let query = supabase
    .from('plataforma_comissoes')
    .select('id, empresa_id, pedido_id, valor_venda, comissao_pct, comissao_valor, criado_em')
    .order('criado_em', { ascending: false });

  if (args.empresa_id) query = query.eq('empresa_id', args.empresa_id);
  if (args.data_inicio) query = query.gte('criado_em', args.data_inicio);
  if (args.data_fim) query = query.lte('criado_em', args.data_fim + 'T23:59:59');

  const { data, error } = await query;
  if (error) throw error;

  const totalComissao = (data ?? []).reduce((acc, c) => acc + (c.comissao_valor ?? 0), 0);

  return {
    comissoes: data,
    total_comissao: totalComissao,
    total_registros: data?.length ?? 0,
  };
}

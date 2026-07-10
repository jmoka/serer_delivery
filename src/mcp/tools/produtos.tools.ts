import { SupabaseClient } from '@supabase/supabase-js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const produtosToolDefinitions: Tool[] = [
  {
    name: 'listar_produtos',
    description: 'Lista produtos de uma empresa com opção de filtrar por categoria.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number' },
        categoria_id: { type: 'number' },
        apenas_ativos: { type: 'boolean' },
      },
      required: ['empresa_id'],
    },
  },
  {
    name: 'listar_categorias',
    description: 'Lista categorias de uma empresa com contagem de produtos.',
    inputSchema: {
      type: 'object',
      properties: {
        empresa_id: { type: 'number' },
      },
      required: ['empresa_id'],
    },
  },
];

export async function executarProdutosTool(
  nome: string,
  args: Record<string, any>,
  supabase: SupabaseClient,
) {
  switch (nome) {
    case 'listar_produtos': return listarProdutos(args, supabase);
    case 'listar_categorias': return listarCategorias(args, supabase);
    default: return null;
  }
}

async function listarProdutos(args: any, supabase: SupabaseClient) {
  // Busca categoria_ids da empresa primeiro
  const { data: cats } = await supabase
    .from('categories')
    .select('id')
    .eq('restaurant_id', args.empresa_id);

  const catIds = (cats ?? []).map((c: any) => c.id);
  if (catIds.length === 0) return { produtos: [], total: 0 };

  let query = supabase
    .from('products')
    .select('id, name, description, price, is_active, category_id, image_url')
    .in('category_id', catIds)
    .order('name');

  if (args.categoria_id) query = query.eq('category_id', args.categoria_id);
  if (args.apenas_ativos) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw error;
  return { produtos: data, total: data?.length ?? 0 };
}

async function listarCategorias(args: any, supabase: SupabaseClient) {
  const { data: cats, error } = await supabase
    .from('categories')
    .select('id, name, restaurant_id')
    .eq('restaurant_id', args.empresa_id)
    .order('name');

  if (error) throw error;

  const catIds = (cats ?? []).map((c: any) => c.id);
  let prodCountMap: Record<number, number> = {};

  if (catIds.length > 0) {
    const { data: prods } = await supabase
      .from('products')
      .select('category_id')
      .in('category_id', catIds);

    for (const p of prods ?? []) {
      prodCountMap[p.category_id] = (prodCountMap[p.category_id] ?? 0) + 1;
    }
  }

  return {
    categorias: (cats ?? []).map((c: any) => ({
      ...c,
      total_produtos: prodCountMap[c.id] ?? 0,
    })),
    total: cats?.length ?? 0,
  };
}

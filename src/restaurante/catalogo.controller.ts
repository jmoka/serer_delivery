import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import * as os from 'os';

const PRODUTO_FIELDS = 'id, name, description, price, preco_promo, image_url, category_id, restaurant_id, tags, destaque, is_active';

@Controller('r')
export class CatalogoController {
  constructor(private supabase: SupabaseService) {}

  @Get('acesso')
  async getAcesso() {
    const nets = os.networkInterfaces();
    const todos: string[] = [];
    for (const iface of Object.values(nets)) {
      for (const net of iface ?? []) {
        if (net.family === 'IPv4' && !net.internal) todos.push(net.address);
      }
    }
    // Prioriza 192.168.x.x (WiFi doméstico/corporativo) e 10.x.x.x (redes corporativas).
    // Descarta 172.16-31.x.x que são WSL, Docker, Hyper-V — não acessíveis por dispositivos reais.
    const score = (ip: string) => {
      if (/^192\.168\./.test(ip)) return 0;
      if (/^10\./.test(ip)) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 99; // virtual — vai por último
      return 2;
    };
    const ips = todos.sort((a, b) => score(a) - score(b));

    const { data } = await this.supabase.client
      .from('platform_settings')
      .select('config')
      .eq('id', 1)
      .maybeSingle();
    const cfg = ((data?.config ?? {}) as Record<string, any>);
    return {
      lan_ips: ips,
      porta: 4028,
      cloudflare_domain: cfg.cloudflare_domain || null,
    };
  }

  @Get()
  async listarRestaurantes() {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .select('id, name, address, logo_url, slug, aparencia, frete_motoboy')
      .not('slug', 'is', null)
      .eq('bloqueado', false)
      .order('name');

    if (error) throw error;
    return { restaurantes: data ?? [] };
  }

  @Get('produtos')
  async todosOsProdutos() {
    const { data: restaurantes } = await this.supabase.client
      .from('restaurants')
      .select('id, name, logo_url, slug, aparencia')
      .not('slug', 'is', null)
      .eq('bloqueado', false);

    if (!restaurantes?.length) return { produtos: [] };

    const restIds = restaurantes.map((r) => r.id);
    const restMap = Object.fromEntries(restaurantes.map((r) => [r.id, r]));

    // Busca diretamente por restaurant_id (não depende de category chain)
    const { data: produtos, error } = await this.supabase.client
      .from('products')
      .select(PRODUTO_FIELDS)
      .eq('is_active', true)
      .in('restaurant_id', restIds)
      .order('name')
      .limit(200);

    if (error) throw error;

    return {
      produtos: (produtos ?? []).map((p) => ({
        ...p,
        restaurante: restMap[p.restaurant_id] ?? null,
      })).filter((p) => p.restaurante),
    };
  }

  @Get(':slug')
  async cardapio(@Param('slug') slug: string) {
    const { data: restaurante } = await this.supabase.client
      .from('restaurants')
      .select('id, name, address, logo_url, business_hours, slug, aparencia, frete_motoboy')
      .eq('slug', slug)
      .maybeSingle();

    if (!restaurante) throw new NotFoundException('Restaurante não encontrado');

    // Categorias do restaurante (próprias + globais para exibição)
    const { data: categorias } = await this.supabase.client
      .from('categories')
      .select('id, name')
      .or(`restaurant_id.eq.${restaurante.id},restaurant_id.is.null`)
      .order('name');

    // Produtos via restaurant_id (forma correta e direta)
    const { data: produtos } = await this.supabase.client
      .from('products')
      .select(PRODUTO_FIELDS)
      .eq('is_active', true)
      .eq('restaurant_id', restaurante.id)
      .order('destaque', { ascending: false })
      .order('name');

    const catSet = new Set((categorias ?? []).map((c) => c.id));

    const cardapio = (categorias ?? []).map((cat) => ({
      ...cat,
      produtos: (produtos ?? []).filter((p) => p.category_id === cat.id),
    })).filter((cat) => cat.produtos.length > 0);

    const destaques = (produtos ?? []).filter((p) => p.destaque);
    const promos = (produtos ?? []).filter(
      (p) => Array.isArray(p.tags) && p.tags.includes('promo') && p.preco_promo != null,
    );
    // Combos são entidade separada — carregados pelo client se necessário
    const combos: any[] = [];

    return { restaurante, cardapio, destaques, promos, combos };
  }
}

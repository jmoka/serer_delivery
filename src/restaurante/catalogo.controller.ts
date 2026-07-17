import { Controller, Get, Headers, NotFoundException, Param, Query } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { haversineKm } from '../common/geo.util';
import * as os from 'os';

const PRODUTO_FIELDS = 'id, name, description, price, preco_promo, image_url, category_id, restaurant_id, tags, destaque, is_active';
const RAIO_KM_PADRAO = 15;

@Controller('r')
export class CatalogoController {
  constructor(
    private supabase: SupabaseService,
    private supabaseJwt: SupabaseJwtService,
  ) {}

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
  async listarRestaurantes(
    @Query()
    query: {
      state?: string;
      city?: string;
      neighborhood?: string;
      cep?: string;
      lat?: string;
      lng?: string;
      raio_km?: string;
    },
    @Headers('authorization') authorization?: string,
  ) {
    let q = this.supabase.client
      .from('restaurants')
      .select('id, name, address, state, city, neighborhood, cep, logo_url, slug, aparencia, frete_motoboy, lat, lng')
      .not('slug', 'is', null)
      .eq('bloqueado', false);

    if (query.state) q = q.ilike('state', query.state);
    if (query.city) q = q.ilike('city', query.city);
    if (query.neighborhood) q = q.ilike('neighborhood', query.neighborhood);
    if (query.cep) q = q.ilike('cep', `${query.cep.replace(/\D/g, '').slice(0, 5)}%`);

    const { data, error } = await q.order('name');
    if (error) throw error;

    let restaurantes = data ?? [];

    // Filtro/ordenação por proximidade — GPS ao vivo do navegador é a fonte principal
    // (comportamento esperado: cliente abre o site, mostra estabelecimentos perto de onde
    // ele está agora). Só cai pro endereço salvo/geocodificado do perfil (ver PerfilService)
    // quando o navegador não mandou lat/lng (GPS negado/indisponível) e o cliente tem token
    // válido — nunca confia numa coordenada de "fallback" vinda do próprio client.
    let lat = query.lat ? parseFloat(query.lat) : null;
    let lng = query.lng ? parseFloat(query.lng) : null;
    let usandoEnderecoSalvo = false;

    if (lat == null && lng == null && authorization?.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length);
      const payload = await this.supabaseJwt.verificar(token);
      if (payload?.sub) {
        const { data: customer } = await this.supabase.client
          .from('customers')
          .select('lat, lng')
          .eq('user_id', payload.sub)
          .maybeSingle();
        if (customer?.lat != null && customer?.lng != null) {
          lat = customer.lat;
          lng = customer.lng;
          usandoEnderecoSalvo = true;
        }
      }
    }

    if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
      const raioKm = query.raio_km ? parseFloat(query.raio_km) : (usandoEnderecoSalvo ? RAIO_KM_PADRAO : null);
      restaurantes = restaurantes
        .map((r) => ({
          ...r,
          distancia_km:
            r.lat != null && r.lng != null
              ? Math.round(haversineKm({ lat, lng }, { lat: r.lat, lng: r.lng }) * 10) / 10
              : null,
        }))
        .filter((r) => raioKm == null || (r.distancia_km != null && r.distancia_km <= raioKm))
        .sort((a, b) => (a.distancia_km ?? Infinity) - (b.distancia_km ?? Infinity));
    }

    return { restaurantes };
  }

  // Valores distintos de estado/cidade/bairro entre restaurantes ativos — alimenta os
  // dropdowns em cascata do filtro geográfico na home pública (evita carregar tudo só
  // pra montar as opções). Precisa vir ANTES de @Get(':slug') na ordem das rotas.
  @Get('filtros')
  async filtrosGeograficos() {
    const { data, error } = await this.supabase.client
      .from('restaurants')
      .select('state, city, neighborhood')
      .not('slug', 'is', null)
      .eq('bloqueado', false);
    if (error) throw error;

    const vistos = new Set<string>();
    const locais: { state: string | null; city: string | null; neighborhood: string | null }[] = [];
    for (const r of data ?? []) {
      if (!r.state && !r.city && !r.neighborhood) continue;
      const key = `${r.state ?? ''}|${r.city ?? ''}|${r.neighborhood ?? ''}`;
      if (vistos.has(key)) continue;
      vistos.add(key);
      locais.push({ state: r.state, city: r.city, neighborhood: r.neighborhood });
    }
    return { locais };
  }

  @Get('produtos')
  async todosOsProdutos() {
    const { data: restaurantes } = await this.supabase.client
      .from('restaurants')
      .select('id, name, logo_url, slug, aparencia, frete_motoboy')
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

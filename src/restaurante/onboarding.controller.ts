import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from '../motoboy/geocoding.service';

@Controller('restaurante')
export class OnboardingController {
  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
  ) {}

  // Endpoint acessível por qualquer usuário logado — cria restaurante e eleva role
  @Post('registrar')
  @UseGuards(JwtGuard)
  async registrar(
    @Req() req: any,
    @Body()
    body: {
      name: string;
      address?: string;
      state?: string;
      city?: string;
      neighborhood?: string;
      cep?: string;
      business_hours?: object;
      type_id?: number;
    },
  ) {
    const userId: string = req.userId;

    // Se já tem restaurante, retorna ele
    const { data: existing } = await this.supabase.client
      .from('restaurants')
      .select('id, name')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) return { restaurant: existing, already_registered: true };

    const slug = body.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').trim();

    // Cria restaurante
    const { data: restaurant, error } = await this.supabase.client
      .from('restaurants')
      .insert({
        name: body.name,
        address: body.address ?? null,
        state: body.state ?? null,
        city: body.city ?? null,
        neighborhood: body.neighborhood ?? null,
        cep: body.cep ? body.cep.replace(/\D/g, '') : null,
        business_hours: body.business_hours ?? {},
        type_id: body.type_id ?? null,
        user_id: userId,
        comissao_pct: 5.0,
        slug,
      })
      .select()
      .single();

    if (error) throw error;

    // Geocodifica em background (best-effort) — sem isso o restaurante nunca aparece no
    // filtro por raio/km da home até o dono re-salvar o endereço em Config manualmente.
    if (restaurant.address || restaurant.cep) {
      const texto = [restaurant.address, restaurant.neighborhood, restaurant.city, restaurant.state, restaurant.cep]
        .filter(Boolean).join(', ');
      this.geocoding.geocodeEndereco(texto).then((coords) => {
        if (!coords) return;
        return this.supabase.client
          .from('restaurants')
          .update({ lat: coords.lat, lng: coords.lng, geocoded_at: new Date().toISOString(), geocode_falhou: false })
          .eq('id', restaurant.id);
      }).catch(() => {});
    }

    // Eleva role para restaurant_owner (service_role bypassa RLS)
    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'restaurant_owner', updated_at: new Date().toISOString() })
      .eq('id', userId);

    return { restaurant };
  }
}

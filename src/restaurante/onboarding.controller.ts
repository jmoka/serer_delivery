import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt.guard';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('restaurante')
export class OnboardingController {
  constructor(private supabase: SupabaseService) {}

  // Endpoint acessível por qualquer usuário logado — cria restaurante e eleva role
  @Post('registrar')
  @UseGuards(JwtGuard)
  async registrar(
    @Req() req: any,
    @Body()
    body: {
      name: string;
      address?: string;
      business_hours?: object;
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
        business_hours: body.business_hours ?? {},
        user_id: userId,
        comissao_pct: 5.0,
        slug,
      })
      .select()
      .single();

    if (error) throw error;

    // Eleva role para restaurant_owner (service_role bypassa RLS)
    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'restaurant_owner', updated_at: new Date().toISOString() })
      .eq('id', userId);

    return { restaurant };
  }
}

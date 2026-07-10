import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class PerfilService {
  constructor(private supabase: SupabaseService) {}

  async getMeuPerfil(userId: string) {
    const { data } = await this.supabase.client
      .from('customers')
      .select('id, name, email, phone_e164, address_json')
      .eq('user_id', userId)
      .maybeSingle();

    if (data) return data;

    // Primeira vez: cria a partir dos dados do user_profiles
    const { data: up } = await this.supabase.client
      .from('user_profiles')
      .select('name, email')
      .eq('id', userId)
      .maybeSingle();

    const { data: novo } = await this.supabase.client
      .from('customers')
      .insert({ name: up?.name ?? 'Cliente', email: up?.email ?? null, user_id: userId })
      .select('id, name, email, phone_e164, address_json')
      .single();

    return novo;
  }

  async updateMeuPerfil(
    userId: string,
    body: { name?: string; phone_e164?: string; address_json?: Record<string, any> },
  ) {
    const { data: existing } = await this.supabase.client
      .from('customers')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      const { data } = await this.supabase.client
        .from('customers')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('id, name, email, phone_e164, address_json')
        .single();
      return data;
    }

    const { data: up } = await this.supabase.client
      .from('user_profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();

    const { data } = await this.supabase.client
      .from('customers')
      .insert({ ...body, email: up?.email ?? null, user_id: userId })
      .select('id, name, email, phone_e164, address_json')
      .single();

    return data;
  }
}

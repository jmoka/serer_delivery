import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { GeocodingService } from '../motoboy/geocoding.service';

const SELECT_PERFIL = 'id, name, email, phone_e164, address_json, foto_perfil_url';

@Injectable()
export class PerfilService {
  constructor(
    private supabase: SupabaseService,
    private geocoding: GeocodingService,
  ) {}

  async getMeuPerfil(userId: string) {
    const { data } = await this.supabase.client
      .from('customers')
      .select(SELECT_PERFIL)
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
      .select(SELECT_PERFIL)
      .single();

    return novo;
  }

  async updateMeuPerfil(
    userId: string,
    body: { name?: string; phone_e164?: string; address_json?: Record<string, any> },
  ) {
    if (body.address_json) {
      const { logradouro, numero } = body.address_json;
      if (!logradouro?.toString().trim() || !numero?.toString().trim()) {
        throw new BadRequestException('Endereço precisa de logradouro e número');
      }
    }

    const { data: existing } = await this.supabase.client
      .from('customers')
      .select('id, address_geocode_hash')
      .eq('user_id', userId)
      .maybeSingle();

    let data: any;
    let customerId: number;

    if (existing) {
      const res = await this.supabase.client
        .from('customers')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select(SELECT_PERFIL)
        .single();
      data = res.data;
      customerId = existing.id;
    } else {
      const { data: up } = await this.supabase.client
        .from('user_profiles')
        .select('email')
        .eq('id', userId)
        .maybeSingle();

      const res = await this.supabase.client
        .from('customers')
        .insert({ ...body, email: up?.email ?? null, user_id: userId })
        .select(SELECT_PERFIL)
        .single();
      data = res.data;
      customerId = data.id;
    }

    // Geocodifica o endereço salvo pra alimentar o filtro por raio/KM da home quando o
    // cliente não tiver GPS ao vivo — nunca deixa uma falha do Nominatim derrubar o save.
    if (body.address_json) {
      try {
        const resultado = await this.geocoding.geocodificarSeNecessario(body.address_json, existing?.address_geocode_hash ?? null);
        if (resultado) {
          await this.supabase.client
            .from('customers')
            .update({
              lat: resultado.lat,
              lng: resultado.lng,
              address_geocode_hash: resultado.hash,
              address_geocoded_at: new Date().toISOString(),
            })
            .eq('id', customerId);
        }
      } catch {
        // silencioso — perfil já foi salvo, geocodificação é best-effort
      }
    }

    return data;
  }

  // Bucket público separado do de imagens de produto/restaurante — foto de perfil não é
  // documento sensível (diferente das fotos/documentos de motoboy, que usam URL assinada).
  private async setupStorageAvatares() {
    const BUCKET = 'customer-avatars';
    const { data: buckets } = await this.supabase.client.storage.listBuckets();
    const exists = (buckets ?? []).some((b: any) => b.id === BUCKET);

    if (!exists) {
      const { error } = await this.supabase.client.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
      });
      if (error) throw error;
    }
  }

  async uploadFoto(userId: string, file: Express.Multer.File) {
    const { data: customer } = await this.supabase.client
      .from('customers')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (!customer) throw new NotFoundException('Perfil não encontrado');

    const BUCKET = 'customer-avatars';
    await this.setupStorageAvatares();

    const ext = (file.originalname.split('.').pop() ?? 'jpg').toLowerCase();
    const path = `${customer.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .upload(path, file.buffer, { cacheControl: '3600', upsert: false, contentType: file.mimetype });
    if (error) throw error;

    const { data: pub } = this.supabase.client.storage.from(BUCKET).getPublicUrl(path);

    await this.supabase.client
      .from('customers')
      .update({ foto_perfil_url: pub.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', customer.id);

    return { foto_perfil_url: pub.publicUrl };
  }
}

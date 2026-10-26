import { Injectable, NotFoundException } from '@nestjs/common';
import * as geoip from 'geoip-lite';
import { SupabaseService } from '../supabase/supabase.service';
import { EncryptionService } from '../common/encryption.service';
import { RegistrarVisitaDto } from './visitas.dto';

// Entre dois heartbeats sucessivos, nunca soma mais que isso — cliente que
// ficou em background/sleep e voltou não pode inflar duração artificialmente.
const HEARTBEAT_MAX_SEGUNDOS = 120;

@Injectable()
export class VisitasService {
  constructor(
    private supabase: SupabaseService,
    private encryption: EncryptionService,
  ) {}

  async registrar(dto: RegistrarVisitaDto, ipReal: string, userAgent: string | undefined) {
    const geo = ipReal ? geoip.lookup(ipReal) : null;

    const { data, error } = await this.supabase.client
      .from('visitas')
      .insert({
        empresa_id: dto.empresa_id ? parseInt(dto.empresa_id) : null,
        ip_cripto: this.encryption.encrypt(ipReal || 'desconhecido'),
        pais: geo?.country ?? null,
        regiao: geo?.region ?? null,
        cidade: geo?.city ?? null,
        lat: geo?.ll?.[0] ?? null,
        lng: geo?.ll?.[1] ?? null,
        user_agent: userAgent ?? null,
        path_inicial: dto.path_inicial,
        referrer: dto.referrer ?? null,
      })
      .select('id')
      .single();

    if (error) throw error;
    return { id: data.id };
  }

  async heartbeat(id: number) {
    const { data: visita, error: erroBusca } = await this.supabase.client
      .from('visitas')
      .select('id, duracao_segundos, atualizado_em')
      .eq('id', id)
      .maybeSingle();

    if (erroBusca) throw erroBusca;
    if (!visita) throw new NotFoundException('Visita não encontrada');

    const segundosDesdeUltimo = Math.max(0, (Date.now() - new Date(visita.atualizado_em).getTime()) / 1000);
    const incremento = Math.min(segundosDesdeUltimo, HEARTBEAT_MAX_SEGUNDOS);

    const { error } = await this.supabase.client
      .from('visitas')
      .update({
        duracao_segundos: visita.duracao_segundos + Math.round(incremento),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw error;
    return { ok: true };
  }

  async listarAdmin(filtros: { empresa_id?: number; limite?: number }) {
    let query = this.supabase.client
      .from('visitas')
      .select('id, empresa_id, pais, regiao, cidade, lat, lng, ip_cripto, path_inicial, referrer, duracao_segundos, criado_em')
      .order('criado_em', { ascending: false })
      .limit(filtros.limite ?? 200);

    if (filtros.empresa_id) query = query.eq('empresa_id', filtros.empresa_id);

    const { data, error } = await query;
    if (error) throw error;

    const visitas = (data ?? []).map((v) => ({
      ...v,
      ip: this.encryption.decryptNullable(v.ip_cripto),
      ip_cripto: undefined,
    }));

    const totalVisitas = visitas.length;
    const duracaoMedia = totalVisitas > 0
      ? Math.round(visitas.reduce((acc, v) => acc + (v.duracao_segundos ?? 0), 0) / totalVisitas)
      : 0;
    const pontosMapa = visitas
      .filter((v) => v.lat != null && v.lng != null)
      .map((v) => ({ lat: v.lat, lng: v.lng, cidade: v.cidade, pais: v.pais }));

    return {
      resumo: { total_visitas: totalVisitas, duracao_media_segundos: duracaoMedia },
      pontos_mapa: pontosMapa,
      visitas,
    };
  }
}

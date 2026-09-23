import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RedisService } from '../redis/redis.service';

export type PerfilAcademia = 'estabelecimento' | 'motoboy' | 'garcom' | 'cliente';

export interface ProgressoAcademia {
  assistidos: Record<string, string>; // video_id -> timestamp ISO de quando foi marcado
}

export interface VideoAcademiaInput {
  titulo: string;
  descricao?: string | null;
  categoria: string;
  perfis: PerfilAcademia[];
  url_video: string;
  duracao_seg?: number | null;
  ordem?: number;
  ativo?: boolean;
}

const VAZIO: ProgressoAcademia = { assistidos: {} };
const TTL_CACHE = 300;
const BUCKET_VIDEOS = 'academia-videos';

// Progresso de "já assisti" da Academia PediuVai — mesmo padrão de
// FavoritosMenuService: um blob JSONB por escopo em user_profiles, cache
// Redis best-effort invalidado a cada PATCH.
@Injectable()
export class AcademiaService {
  constructor(
    private supabase: SupabaseService,
    private redis: RedisService,
  ) {}

  private cacheKey(perfil: PerfilAcademia, userId: string) {
    return `academia-progresso:${perfil}:${userId}`;
  }

  async obter(perfil: PerfilAcademia, userId: string): Promise<ProgressoAcademia> {
    const cacheKey = this.cacheKey(perfil, userId);
    const cached = await this.redis.getJSON<ProgressoAcademia>(cacheKey);
    if (cached) return cached;

    const { data } = await this.supabase.client
      .from('user_profiles')
      .select('academia_progresso')
      .eq('id', userId)
      .maybeSingle();

    const doEscopo = (data?.academia_progresso ?? {})[perfil] ?? {};
    const resultado: ProgressoAcademia = {
      assistidos: typeof doEscopo === 'object' && doEscopo ? doEscopo : VAZIO.assistidos,
    };

    await this.redis.setJSON(cacheKey, resultado, TTL_CACHE);
    return resultado;
  }

  async marcarAssistido(perfil: PerfilAcademia, userId: string, videoId: string): Promise<ProgressoAcademia> {
    const { data: atual } = await this.supabase.client
      .from('user_profiles')
      .select('academia_progresso')
      .eq('id', userId)
      .maybeSingle();

    const todos = atual?.academia_progresso ?? {};
    const doEscopo = todos[perfil] ?? {};

    const novoEscopo = { ...doEscopo, [videoId]: new Date().toISOString() };

    const { error } = await this.supabase.client
      .from('user_profiles')
      .update({ academia_progresso: { ...todos, [perfil]: novoEscopo } })
      .eq('id', userId);
    if (error) throw error;

    const resultado: ProgressoAcademia = { assistidos: novoEscopo };
    await this.redis.setJSON(this.cacheKey(perfil, userId), resultado, TTL_CACHE);
    return resultado;
  }

  // ── Catálogo (tabela academia_videos, gerenciada pelo admin) ──────────

  async listarCatalogo(perfil?: PerfilAcademia) {
    let query = this.supabase.client
      .from('academia_videos')
      .select('*')
      .eq('ativo', true)
      .order('categoria', { ascending: true })
      .order('ordem', { ascending: true });

    if (perfil) query = query.contains('perfis', [perfil]);

    const { data, error } = await query;
    if (error) throw error;
    return { videos: data ?? [] };
  }

  async listarTodosAdmin() {
    const { data, error } = await this.supabase.client
      .from('academia_videos')
      .select('*')
      .order('categoria', { ascending: true })
      .order('ordem', { ascending: true });
    if (error) throw error;
    return { videos: data ?? [] };
  }

  async criarVideo(input: VideoAcademiaInput) {
    const { data, error } = await this.supabase.client
      .from('academia_videos')
      .insert({
        titulo: input.titulo,
        descricao: input.descricao ?? null,
        categoria: input.categoria,
        perfis: input.perfis,
        url_video: input.url_video,
        duracao_seg: input.duracao_seg ?? null,
        ordem: input.ordem ?? 0,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async atualizarVideo(id: string, input: Partial<VideoAcademiaInput>) {
    const campos: Record<string, any> = { atualizado_em: new Date().toISOString() };
    if (input.titulo !== undefined) campos.titulo = input.titulo;
    if (input.descricao !== undefined) campos.descricao = input.descricao;
    if (input.categoria !== undefined) campos.categoria = input.categoria;
    if (input.perfis !== undefined) campos.perfis = input.perfis;
    if (input.url_video !== undefined) campos.url_video = input.url_video;
    if (input.duracao_seg !== undefined) campos.duracao_seg = input.duracao_seg;
    if (input.ordem !== undefined) campos.ordem = input.ordem;
    if (input.ativo !== undefined) campos.ativo = input.ativo;

    const { data, error } = await this.supabase.client
      .from('academia_videos')
      .update(campos)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async removerVideo(id: string) {
    const { error } = await this.supabase.client.from('academia_videos').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  private async setupStorageAcademia() {
    const { data: buckets } = await this.supabase.client.storage.listBuckets();
    const exists = (buckets ?? []).some((b: any) => b.id === BUCKET_VIDEOS);

    if (!exists) {
      const { error } = await this.supabase.client.storage.createBucket(BUCKET_VIDEOS, {
        public: true,
        fileSizeLimit: 200 * 1024 * 1024,
        allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
      });
      if (error) throw error;
    }
  }

  async uploadVideo(file: Express.Multer.File) {
    await this.setupStorageAcademia();

    const ext = (file.originalname.split('.').pop() ?? 'mp4').toLowerCase();
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(BUCKET_VIDEOS)
      .upload(path, file.buffer, { cacheControl: '3600', upsert: false, contentType: file.mimetype });
    if (error) throw error;

    const { data } = this.supabase.client.storage.from(BUCKET_VIDEOS).getPublicUrl(path);
    return { url: this.supabase.toPublicUrl(data.publicUrl) };
  }
}

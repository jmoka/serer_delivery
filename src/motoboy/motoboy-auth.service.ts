import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // igual ao expiresIn do JWT

// identificador/email/phone entram direto num filtro .or() do PostgREST — sem
// validar formato, um valor com vírgula/parênteses injeta cláusulas extras
// no filtro (ex. ",id.gt.0").
export const EMAIL_RE = /^[^\s,()]+@[^\s,()]+\.[^\s,()]+$/;
export const PHONE_RE = /^\+?[0-9]{8,15}$/;

export interface CadastroMotoboyBody {
  name: string;
  phone: string;
  email: string;
  password: string;
  foto_perfil: string;
  documento_frente: string;
  documento_verso?: string;
  comprovante_endereco: string;
  // Token da sessão de cliente (Supabase Auth) já logada, se houver — usado
  // pra vincular a conta e promover user_profiles.role pra 'motoboy'.
  supabase_access_token?: string;
}

const BUCKET = 'motoboy-documentos';

@Injectable()
export class MotoboyAuthService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private supabaseJwt: SupabaseJwtService,
  ) {}

  // Se veio um token de cliente logado, vincula o motoboy a essa conta e
  // promove user_profiles.role pra 'motoboy' — a pessoa deixa de contar como
  // cliente comum a partir daqui (decisão do produto).
  private async vincularContaCliente(motoboyId: number, supabaseAccessToken?: string) {
    if (!supabaseAccessToken) return;

    const verified = await this.supabaseJwt.verificar(supabaseAccessToken);
    const userId = verified?.sub;
    if (!userId) return;

    await this.supabase.client.from('motoboys').update({ user_id: userId }).eq('id', motoboyId);
    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'motoboy', updated_at: new Date().toISOString() })
      .eq('id', userId);
  }

  private gerarToken(motoboyId: number, sessionId: string): string {
    const secret = this.config.getOrThrow('MOTOBOY_JWT_SECRET');
    return jwt.sign({ motoboyId, sessionId }, secret, { expiresIn: '30d' });
  }

  // Só abre sessão nova se não houver outra ativa (ou se a anterior já expirou) —
  // update condicional atômico evita corrida entre dois logins simultâneos.
  private async abrirSessao(motoboyId: number): Promise<string> {
    const sessionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    const { data } = await this.supabase.client
      .from('motoboys')
      .update({ active_session_id: sessionId, session_expires_at: expiresAt })
      .eq('id', motoboyId)
      .or(`active_session_id.is.null,session_expires_at.lt.${nowIso}`)
      .select('id')
      .maybeSingle();

    if (!data) {
      throw new ConflictException('Este motoboy já está logado em outro dispositivo. Peça pro estabelecimento liberar o acesso.');
    }
    return sessionId;
  }

  private async criarSessaoEToken(motoboyId: number): Promise<string> {
    const sessionId = await this.abrirSessao(motoboyId);
    return this.gerarToken(motoboyId, sessionId);
  }

  async logout(motoboyId: number) {
    await this.supabase.client
      .from('motoboys')
      .update({ active_session_id: null, session_expires_at: null })
      .eq('id', motoboyId);
    return { ok: true };
  }

  // Bucket privado — grava o path do objeto, não a URL (URL é gerada sob demanda via signed URL).
  private async uploadDocumento(motoboyId: number, campo: string, base64: string): Promise<string> {
    const matches = base64.match(/^data:([\w/+-]+);base64,(.+)$/);
    const mimeType = matches ? matches[1] : 'image/jpeg';
    const raw = matches ? matches[2] : base64;
    const buffer = Buffer.from(raw, 'base64');
    const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
    const path = `${motoboyId}/${campo}-${Date.now()}.${ext}`;

    const { error } = await this.supabase.client.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: mimeType, upsert: true });
    if (error) throw error;

    return path;
  }

  async cadastro(body: CadastroMotoboyBody) {
    if (!body.email && !body.phone) throw new BadRequestException('Informe telefone ou e-mail');
    if (!body.password || body.password.length < 8) throw new BadRequestException('Senha deve ter no mínimo 8 caracteres');
    if (body.email && !EMAIL_RE.test(body.email)) throw new BadRequestException('E-mail inválido');
    if (body.phone && !PHONE_RE.test(body.phone)) throw new BadRequestException('Telefone inválido');

    const { data: existente } = await this.supabase.client
      .from('motoboys')
      .select('id')
      .or(`email.eq.${body.email},phone.eq.${body.phone}`)
      .maybeSingle();
    if (existente) throw new ConflictException('Já existe um cadastro com este telefone ou e-mail');

    const passwordHash = await bcrypt.hash(body.password, 10);

    const { data: motoboy, error } = await this.supabase.client
      .from('motoboys')
      .insert({
        name: body.name,
        phone: body.phone,
        email: body.email,
        password_hash: passwordHash,
        precisa_completar_cadastro: false,
      })
      .select('id')
      .single();
    if (error) throw error;

    const [foto_perfil_url, documento_frente_url, documento_verso_url, comprovante_endereco_url] = await Promise.all([
      this.uploadDocumento(motoboy.id, 'foto-perfil', body.foto_perfil),
      this.uploadDocumento(motoboy.id, 'documento-frente', body.documento_frente),
      body.documento_verso ? this.uploadDocumento(motoboy.id, 'documento-verso', body.documento_verso) : Promise.resolve(null),
      this.uploadDocumento(motoboy.id, 'comprovante-endereco', body.comprovante_endereco),
    ]);

    await this.supabase.client
      .from('motoboys')
      .update({ foto_perfil_url, documento_frente_url, documento_verso_url, comprovante_endereco_url })
      .eq('id', motoboy.id);

    await this.vincularContaCliente(motoboy.id, body.supabase_access_token);

    return { token: await this.criarSessaoEToken(motoboy.id) };
  }

  async login(identificador: string, password: string) {
    if (!EMAIL_RE.test(identificador) && !PHONE_RE.test(identificador)) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const { data: motoboy } = await this.supabase.client
      .from('motoboys')
      .select('id, password_hash, is_active')
      .or(`email.eq.${identificador},phone.eq.${identificador}`)
      .maybeSingle();

    if (!motoboy?.password_hash) throw new UnauthorizedException('Credenciais inválidas');
    if (!motoboy.is_active) throw new UnauthorizedException('Conta desativada');

    const ok = await bcrypt.compare(password, motoboy.password_hash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');

    return { token: await this.criarSessaoEToken(motoboy.id) };
  }

  // Motoboys antigos (criados antes do login por senha) — completam cadastro usando o token legado.
  async completarCadastro(motoboyId: number, body: CadastroMotoboyBody) {
    if (!body.password || body.password.length < 8) throw new BadRequestException('Senha deve ter no mínimo 8 caracteres');

    const passwordHash = await bcrypt.hash(body.password, 10);

    const [foto_perfil_url, documento_frente_url, documento_verso_url, comprovante_endereco_url] = await Promise.all([
      this.uploadDocumento(motoboyId, 'foto-perfil', body.foto_perfil),
      this.uploadDocumento(motoboyId, 'documento-frente', body.documento_frente),
      body.documento_verso ? this.uploadDocumento(motoboyId, 'documento-verso', body.documento_verso) : Promise.resolve(null),
      this.uploadDocumento(motoboyId, 'comprovante-endereco', body.comprovante_endereco),
    ]);

    const { error } = await this.supabase.client
      .from('motoboys')
      .update({
        name: body.name,
        phone: body.phone,
        email: body.email,
        password_hash: passwordHash,
        foto_perfil_url,
        documento_frente_url,
        documento_verso_url,
        comprovante_endereco_url,
        precisa_completar_cadastro: false,
      })
      .eq('id', motoboyId);
    if (error) throw error;

    await this.vincularContaCliente(motoboyId, body.supabase_access_token);

    return { token: await this.criarSessaoEToken(motoboyId) };
  }
}

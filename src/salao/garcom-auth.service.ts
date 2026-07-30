import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // igual ao expiresIn do JWT

@Injectable()
export class GarcomAuthService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  private gerarToken(garcomId: number, sessionId: string): string {
    const secret = this.config.getOrThrow('GARCOM_JWT_SECRET');
    return jwt.sign({ garcomId, sessionId }, secret, { expiresIn: '12h' });
  }

  // Só abre sessão nova se não houver outra ativa (ou se a anterior já expirou) —
  // update condicional atômico evita corrida entre dois logins simultâneos.
  private async abrirSessao(garcomId: number): Promise<string> {
    const sessionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    const { data } = await this.supabase.client
      .from('garcons')
      .update({ active_session_id: sessionId, session_expires_at: expiresAt })
      .eq('id', garcomId)
      .or(`active_session_id.is.null,session_expires_at.lt.${nowIso}`)
      .select('id')
      .maybeSingle();

    if (!data) {
      throw new ConflictException('Este garçom já está logado em outro dispositivo. Peça pro estabelecimento liberar o acesso.');
    }
    return sessionId;
  }

  async login(loginKey: string, password: string) {
    if (!loginKey || !password) throw new BadRequestException('Informe usuário e senha');

    const { data: garcom } = await this.supabase.client
      .from('garcons')
      .select('id, password_hash, ativo, restaurants(aparencia)')
      .eq('login_key', loginKey)
      .maybeSingle();

    if (!garcom?.password_hash) throw new UnauthorizedException('Credenciais inválidas');
    if (!garcom.ativo) throw new UnauthorizedException('Acesso desativado');

    const ok = await bcrypt.compare(password, garcom.password_hash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');

    const restauranteAberto = (garcom as any).restaurants?.aparencia?.aberto === true;
    if (!restauranteAberto) throw new ForbiddenException('Restaurante fechado. Aguarde o caixa ser aberto para entrar.');

    const sessionId = await this.abrirSessao(garcom.id);

    return { token: this.gerarToken(garcom.id, sessionId), restauranteAberto };
  }

  async logout(garcomId: number) {
    await this.supabase.client
      .from('garcons')
      .update({ active_session_id: null, session_expires_at: null })
      .eq('id', garcomId);
    return { ok: true };
  }
}

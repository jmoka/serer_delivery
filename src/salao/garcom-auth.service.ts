import { BadRequestException, UnauthorizedException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class GarcomAuthService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  private gerarToken(garcomId: number): string {
    const secret = this.config.getOrThrow('GARCOM_JWT_SECRET');
    return jwt.sign({ garcomId }, secret, { expiresIn: '12h' });
  }

  async login(loginKey: string, password: string) {
    if (!loginKey || !password) throw new BadRequestException('Informe usuário e senha');

    const { data: garcom } = await this.supabase.client
      .from('garcons')
      .select('id, password_hash, ativo')
      .eq('login_key', loginKey)
      .maybeSingle();

    if (!garcom?.password_hash) throw new UnauthorizedException('Credenciais inválidas');
    if (!garcom.ativo) throw new UnauthorizedException('Acesso desativado');

    const ok = await bcrypt.compare(password, garcom.password_hash);
    if (!ok) throw new UnauthorizedException('Credenciais inválidas');

    return { token: this.gerarToken(garcom.id) };
  }
}

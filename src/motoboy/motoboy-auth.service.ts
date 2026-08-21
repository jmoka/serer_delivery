import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

// e-mail/phone entram direto num filtro .or() do PostgREST — sem validar formato,
// um valor com vírgula/parênteses injeta cláusulas extras no filtro (ex. ",id.gt.0").
export const EMAIL_RE = /^[^\s,()]+@[^\s,()]+\.[^\s,()]+$/;
export const PHONE_RE = /^\+?[0-9]{8,15}$/;

export interface CompletarCadastroMotoboyBody {
  name: string;
  phone: string;
  foto_perfil: string;
  documento_frente: string;
  documento_verso?: string;
  comprovante_endereco: string;
}

const BUCKET = 'motoboy-documentos';

@Injectable()
export class MotoboyAuthService {
  constructor(private supabase: SupabaseService) {}

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

  // Chamado logo após o frontend criar a conta via supabase.auth.signUp() —
  // completa o cadastro do motoboy (docs, telefone) vinculado a essa conta real.
  // E-mail vem de user_profiles (populado pelo trigger handle_new_user no signUp),
  // não do body, pra não poder ser forjado.
  async completarCadastro(userId: string, body: CompletarCadastroMotoboyBody) {
    // Motoboy e dono de estabelecimento precisam ser contas separadas — regra
    // espelhada em OnboardingController.registrarInicial.
    const { data: restauranteVinculado } = await this.supabase.client
      .from('restaurants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (restauranteVinculado) {
      throw new ForbiddenException('Esta conta já é de um estabelecimento. Cadastre-se como motoboy usando outra conta.');
    }

    // Idempotente — reload/retry depois de já ter completado não deve duplicar.
    const { data: existente } = await this.supabase.client
      .from('motoboys')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (existente) throw new ConflictException('Cadastro de motoboy já concluído para esta conta.');

    const { data: perfil } = await this.supabase.client
      .from('user_profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    if (!perfil?.email) throw new NotFoundException('Conta não encontrada.');

    if (!body.name?.trim()) throw new BadRequestException('Informe o nome');
    if (body.phone && !PHONE_RE.test(body.phone)) throw new BadRequestException('Telefone inválido');

    const { data: motoboy, error } = await this.supabase.client
      .from('motoboys')
      .insert({
        user_id: userId,
        name: body.name.trim(),
        phone: body.phone || null,
        email: perfil.email,
        precisa_completar_cadastro: false,
        status_plataforma: 'pendente',
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

    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'motoboy', updated_at: new Date().toISOString() })
      .eq('id', userId);

    return { ok: true };
  }
}

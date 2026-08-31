import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CnpjService } from './cnpj.service';
import { uploadDocumentoMotoboy } from './upload-documento-motoboy.util';

// e-mail/phone entram direto num filtro .or() do PostgREST — sem validar formato,
// um valor com vírgula/parênteses injeta cláusulas extras no filtro (ex. ",id.gt.0").
export const EMAIL_RE = /^[^\s,()]+@[^\s,()]+\.[^\s,()]+$/;
export const PHONE_RE = /^\+?[0-9]{8,15}$/;
export const VEICULO_TIPOS = ['bicicleta', 'moto', 'carro', 'caminhao', 'carretinha'] as const;

export interface CompletarCadastroMotoboyBody {
  name: string;
  phone: string;
  foto_perfil: string;
  documento_frente: string;
  documento_verso?: string;
  comprovante_endereco: string;
  veiculo_tipo: string;
  cnpj: string;
  veiculo_foto: string;
  veiculo_documento: string;
  veiculo_documento_carretinha?: string;
}

// Consulta o CNPJ e resolve mei_situacao/mei_caminhoneiro — mesma regra usada
// no cadastro pelo restaurante (MotoboyService.criarPeloRestaurante).
export async function resolverSituacaoMei(cnpjService: CnpjService, cnpj: string, veiculoTipo: string) {
  const resultado = await cnpjService.consultarCnpj(cnpj);
  if (!resultado) return { mei_situacao: 'revisao_manual', mei_cnae_principal: null, mei_caminhoneiro: false };
  if (!resultado.ehMei) return { mei_situacao: 'invalido', mei_cnae_principal: resultado.cnae, mei_caminhoneiro: false };
  if (veiculoTipo === 'caminhao') {
    const ehTransporteCarga = !!resultado.cnae?.startsWith('4930');
    return {
      mei_situacao: ehTransporteCarga ? 'validado' : 'revisao_manual',
      mei_cnae_principal: resultado.cnae,
      mei_caminhoneiro: ehTransporteCarga,
    };
  }
  return { mei_situacao: 'validado', mei_cnae_principal: resultado.cnae, mei_caminhoneiro: false };
}

@Injectable()
export class MotoboyAuthService {
  constructor(private supabase: SupabaseService, private cnpj: CnpjService) {}

  private uploadDocumento(motoboyId: number, campo: string, base64: string): Promise<string> {
    return uploadDocumentoMotoboy(this.supabase, motoboyId, campo, base64);
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
    if (!VEICULO_TIPOS.includes(body.veiculo_tipo as any)) throw new BadRequestException('Tipo de veículo inválido');
    const cnpjNorm = (body.cnpj ?? '').replace(/\D/g, '');
    if (cnpjNorm.length !== 14) throw new BadRequestException('CNPJ inválido');
    // Carretinha é puxada por um carro — precisa do CRLV dos dois.
    if (body.veiculo_tipo === 'carretinha' && !body.veiculo_documento_carretinha) {
      throw new BadRequestException('Envie o documento da carretinha (CRLV), além do documento do carro');
    }

    const { data: motoboy, error } = await this.supabase.client
      .from('motoboys')
      .insert({
        user_id: userId,
        name: body.name.trim(),
        phone: body.phone || null,
        email: perfil.email,
        precisa_completar_cadastro: false,
        status_plataforma: 'pendente',
        veiculo_tipo: body.veiculo_tipo,
        cnpj: cnpjNorm,
      })
      .select('id')
      .single();
    if (error) throw error;

    const [
      foto_perfil_url,
      documento_frente_url,
      documento_verso_url,
      comprovante_endereco_url,
      veiculo_foto_url,
      veiculo_documento_url,
      veiculo_documento_carretinha_url,
    ] = await Promise.all([
      this.uploadDocumento(motoboy.id, 'foto-perfil', body.foto_perfil),
      this.uploadDocumento(motoboy.id, 'documento-frente', body.documento_frente),
      body.documento_verso ? this.uploadDocumento(motoboy.id, 'documento-verso', body.documento_verso) : Promise.resolve(null),
      this.uploadDocumento(motoboy.id, 'comprovante-endereco', body.comprovante_endereco),
      this.uploadDocumento(motoboy.id, 'veiculo-foto', body.veiculo_foto),
      this.uploadDocumento(motoboy.id, 'veiculo-documento', body.veiculo_documento),
      body.veiculo_documento_carretinha
        ? this.uploadDocumento(motoboy.id, 'veiculo-documento-carretinha', body.veiculo_documento_carretinha)
        : Promise.resolve(null),
    ]);

    const situacaoMei = await resolverSituacaoMei(this.cnpj, cnpjNorm, body.veiculo_tipo);

    await this.supabase.client
      .from('motoboys')
      .update({
        foto_perfil_url,
        documento_frente_url,
        documento_verso_url,
        comprovante_endereco_url,
        veiculo_foto_url,
        veiculo_documento_url,
        veiculo_documento_carretinha_url,
        ...situacaoMei,
        mei_verificado_em: new Date().toISOString(),
      })
      .eq('id', motoboy.id);

    await this.supabase.client
      .from('user_profiles')
      .update({ role: 'motoboy', updated_at: new Date().toISOString() })
      .eq('id', userId);

    return { ok: true };
  }
}

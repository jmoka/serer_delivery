import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

// Envio direto via API do Resend — separado do envio de emails do próprio
// Supabase Auth (recuperação de senha etc.), que já usa Resend como SMTP
// configurado no painel do Supabase, fora deste backend.
@Injectable()
export class TwoFactorEmailService {
  private readonly logger = new Logger(TwoFactorEmailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = config.get<string>('RESEND_2FA_FROM') || 'PediuVai <nao-responda@pediuvai.com.br>';
    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY não configurada — envio de código 2FA por email vai falhar.');
    }
  }

  async enviarCodigo(email: string, codigo: string): Promise<void> {
    if (!this.resend) throw new Error('Envio de email não configurado (RESEND_API_KEY ausente).');

    const { error } = await this.resend.emails.send({
      from: this.from,
      to: email,
      subject: `${codigo} é seu código de verificação`,
      html: `
        <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
          <p>Use o código abaixo para concluir seu login:</p>
          <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; margin: 24px 0;">${codigo}</p>
          <p style="color: #71717A; font-size: 13px;">Expira em 5 minutos. Se não foi você quem tentou entrar, ignore este email.</p>
        </div>
      `,
    });

    if (error) throw new Error(error.message || 'Falha ao enviar código por email');
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class R2Service {
  readonly client: S3Client;
  private readonly bucket: string;
  private readonly urlPublicaBase: string | null;

  constructor(private config: ConfigService) {
    this.bucket = this.config.getOrThrow('R2_BUCKET');
    // R2 não usa regiões de verdade — "auto" é a convenção da própria Cloudflare
    // pros clientes S3-compatible, e forcePathStyle é obrigatório pra qualquer
    // provedor que não seja a AWS original.
    this.client = new S3Client({
      region: 'auto',
      endpoint: this.config.getOrThrow('R2_ENDPOINT'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.getOrThrow('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow('R2_SECRET_ACCESS_KEY'),
      },
    });
    // Opcional: só existe depois que o domínio custom + cache da Cloudflare
    // estiverem configurados na frente do bucket. Sem isso, leitura de objeto
    // privado usa gerarUrlDownloadAssinada() em vez de montarUrlPublica().
    this.urlPublicaBase = this.config.get('R2_PUBLIC_BASE_URL') ?? null;
  }

  async enviarArquivo(
    chave: string,
    corpo: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: chave,
        Body: corpo,
        ContentType: contentType,
      }),
    );
  }

  // URL assinada de upload: o cliente (app/browser) envia o arquivo direto pro
  // R2, sem passar pelo backend — poupa CPU/banda do servidor em uploads
  // grandes (foto/vídeo de produto).
  async gerarUrlUploadAssinada(
    chave: string,
    contentType: string,
    expiraEmSegundos = 300,
  ): Promise<string> {
    const comando = new PutObjectCommand({
      Bucket: this.bucket,
      Key: chave,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, comando, { expiresIn: expiraEmSegundos });
  }

  async gerarUrlDownloadAssinada(
    chave: string,
    expiraEmSegundos = 3600,
  ): Promise<string> {
    const comando = new GetObjectCommand({ Bucket: this.bucket, Key: chave });
    return getSignedUrl(this.client, comando, { expiresIn: expiraEmSegundos });
  }

  // Só funciona depois que o bucket tiver domínio público configurado
  // (custom domain + proxy Cloudflare, ou Public Development URL do R2).
  montarUrlPublica(chave: string): string | null {
    if (!this.urlPublicaBase) return null;
    return `${this.urlPublicaBase.replace(/\/$/, '')}/${chave}`;
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { networkInterfaces } from 'os';

// O proxy de portas do Docker Desktop (Windows/WSL2) às vezes derruba em
// silêncio uma conexão keep-alive ociosa com o Supabase local — o Node tenta
// reaproveitar o socket morto e o fetch falha com "SocketError: other side
// closed (UND_ERR_SOCKET)". Não é erro de dado nem de lógica, é só o socket
// reaproveitado estar morto — uma nova tentativa (socket novo) sempre resolve.
const socketMortoReaproveitado = (err: any): boolean => {
  const causa = err?.cause ?? err;
  return causa?.code === 'UND_ERR_SOCKET' || /other side closed/i.test(String(causa?.message ?? ''));
};

const fetchComRetry: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err: any) {
    if (!socketMortoReaproveitado(err)) throw err;
    return fetch(input, init);
  }
};

// getPublicUrl() do SDK embute o SUPABASE_URL cru na string retornada. Em dev local
// isso vira "http://127.0.0.1:54331/...", que só resolve na própria máquina que roda
// o Supabase — quebra em qualquer outro dispositivo da rede (celular, outro PC) porque
// 127.0.0.1 ali significa "o próprio aparelho pedindo a imagem", não o servidor.
// Em produção o SUPABASE_URL é o Supabase remoto (não bate no regex abaixo), então
// esse caminho nunca é acionado — comportamento de produção fica sempre intocado.
function calcularBaseUrlPublicaLan(supabaseUrl: string): string | null {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(supabaseUrl)) return null;
  const ip = detectarIpLan();
  if (!ip) return null;
  const { protocol, port } = new URL(supabaseUrl);
  return `${protocol}//${ip}${port ? ':' + port : ''}`;
}

// Ignora adaptadores virtuais (Docker Desktop / WSL2 / Hyper-V) que aparecem como
// interface de rede mas não são alcançáveis por outro dispositivo físico da LAN.
function detectarIpLan(): string | null {
  for (const [nome, enderecos] of Object.entries(networkInterfaces())) {
    if (/vEthernet|Virtual|Loopback|WSL|Docker/i.test(nome)) continue;
    for (const endereco of enderecos ?? []) {
      if (endereco.family === 'IPv4' && !endereco.internal) return endereco.address;
    }
  }
  return null;
}

@Injectable()
export class SupabaseService {
  readonly client: SupabaseClient;
  private readonly baseUrlPublicaLan: string | null;

  constructor(private config: ConfigService) {
    const supabaseUrl = this.config.getOrThrow('SUPABASE_URL');
    // service_role ignora RLS — filtrar empresa_id no código SEMPRE
    this.client = createClient(
      supabaseUrl,
      this.config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
      { global: { fetch: fetchComRetry } },
    );
    this.baseUrlPublicaLan = calcularBaseUrlPublicaLan(supabaseUrl);
  }

  // Reescreve URL pública de storage pra funcionar em qualquer dispositivo da rede
  // local (não só na máquina que roda o Supabase). Em produção (SUPABASE_URL remoto)
  // é um no-op — retorna a URL exatamente como o Supabase gerou.
  toPublicUrl(url: string): string {
    if (!this.baseUrlPublicaLan) return url;
    return url.replace(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/, this.baseUrlPublicaLan);
  }
}

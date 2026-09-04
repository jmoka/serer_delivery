import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

@Injectable()
export class SupabaseService {
  readonly client: SupabaseClient;

  constructor(private config: ConfigService) {
    // service_role ignora RLS — filtrar empresa_id no código SEMPRE
    this.client = createClient(
      this.config.getOrThrow('SUPABASE_URL'),
      this.config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
      { global: { fetch: fetchComRetry } },
    );
  }
}

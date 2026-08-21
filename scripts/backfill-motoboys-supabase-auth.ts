// Roda UMA VEZ pra migrar motoboys existentes (login por password_hash/JWT
// próprio) pra contas reais de Supabase Auth. Idempotente — só processa
// linhas com user_id NULL, pode rodar de novo sem duplicar nada.
//
// Uso: npm run backfill:motoboys-auth   (dentro de server_delivery, com .env configurado)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Sem isso o link de recovery cai no Site URL padrão (home), não em
// /reset-password — a pessoa fica "logada" com a sessão de recovery sem
// nunca ver o formulário de nova senha. Deriva do mesmo APP_ALLOWED_ORIGINS
// já usado pro CORS (primeiro domínio da lista).
function redirectToResetPassword(): string | undefined {
  const primeiro = (process.env.APP_ALLOWED_ORIGINS ?? '').split(',')[0]?.trim();
  if (!primeiro) return undefined;
  const local = /^(localhost|127\.|10\.|172\.|192\.168\.)/.test(primeiro);
  return `${local ? 'http' : 'https'}://${primeiro}/reset-password`;
}

async function getOrCreateAuthUser(email: string, senha: string, name: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { name, role: 'motoboy' },
  });
  if (!error) return data.user.id;

  if (error.message?.toLowerCase().includes('already') || error.status === 422) {
    const { data: lista, error: listErro } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErro) throw listErro;
    const existente = lista.users.find((u) => u.email === email);
    if (existente) return existente.id;
  }
  throw error;
}

async function main() {
  const { data: motoboys, error } = await supabase
    .from('motoboys')
    .select('id, name, email, phone')
    .is('user_id', null);
  if (error) throw error;

  if (!motoboys || motoboys.length === 0) {
    console.log('Nenhum motoboy pendente de migração (user_id já preenchido em todos). Nada a fazer.');
    return;
  }

  const pulados: { id: number; name: string }[] = [];
  const migrados: { id: number; name: string; email: string; link: string }[] = [];

  for (const mb of motoboys) {
    if (!mb.email) {
      pulados.push({ id: mb.id, name: mb.name });
      continue;
    }

    const senhaAleatoria = crypto.randomBytes(12).toString('base64url');
    const userId = await getOrCreateAuthUser(mb.email, senhaAleatoria, mb.name);

    const { error: updateErro } = await supabase.from('motoboys').update({ user_id: userId }).eq('id', mb.id);
    if (updateErro) throw updateErro;

    // Senha aleatória é inútil sem isso — motoboy PRECISA resetar antes do
    // primeiro login. generateLink não envia e-mail sozinho, só devolve o link.
    const redirectTo = redirectToResetPassword();
    const { data: linkData, error: linkErro } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: mb.email,
      options: redirectTo ? { redirectTo } : undefined,
    });
    if (linkErro) throw linkErro;

    migrados.push({ id: mb.id, name: mb.name, email: mb.email, link: linkData.properties.action_link });
  }

  console.log(`\nBackfill concluído: ${migrados.length} migrado(s), ${pulados.length} pulado(s).\n`);

  if (migrados.length > 0) {
    console.log('Motoboys migrados — entregue o link de definir senha pra cada um (WhatsApp/e-mail manual):');
    for (const m of migrados) {
      console.log(`  #${m.id} ${m.name} <${m.email}>\n    ${m.link}`);
    }
  }

  if (pulados.length > 0) {
    console.log('\nMotoboys SEM e-mail (não dá pra migrar sozinho — contatar pra coletar e-mail e rodar de novo):');
    for (const p of pulados) {
      console.log(`  #${p.id} ${p.name}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

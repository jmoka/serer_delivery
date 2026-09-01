// Cria motoboys de teste (motoboy1/2/3), já aprovados na plataforma e afiliados
// (status 'aceito') a todas as lojas de teste existentes — pra poder atribuir
// entrega neles direto na tela /restaurante/entregas de qualquer loja de teste,
// sem precisar passar pelo fluxo de solicitação/aprovação de afiliação.
// Idempotente — se o motoboy já existe, só garante a afiliação nas lojas novas.
//
// Uso: npm run seed:motoboys-teste   (dentro de server_delivery, com .env configurado)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SENHA = '123456';
const MOTOBOYS = [
  { email: 'motoboy1@delivery.com', name: 'Motoboy Um' },
  { email: 'motoboy2@delivery.com', name: 'Motoboy Dois' },
  { email: 'motoboy3@delivery.com', name: 'Motoboy Três' },
];

// Lojas de teste que já existem no seed (resto@delivery.com + as duas criadas
// em seed-lojas-teste.ts). Se algum nome não existir ainda (script rodado fora
// de ordem), só pula essa loja — não falha o script inteiro.
const NOMES_LOJAS_TESTE = ['Restaurante Teste', 'Farmácia Teste', 'Material de Construção Teste'];

async function getOrCreateAuthUser(email: string, senha: string, name: string, role: string) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { name, role },
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
  const { data: lojas, error: lojasErro } = await supabase
    .from('restaurants')
    .select('id, name')
    .in('name', NOMES_LOJAS_TESTE);
  if (lojasErro) throw lojasErro;
  if (!lojas?.length) throw new Error('Nenhuma loja de teste encontrada — rode seed:primeiro-boot e seed:lojas-teste antes.');

  for (const m of MOTOBOYS) {
    const userId = await getOrCreateAuthUser(m.email, SENHA, m.name, 'motoboy');

    let { data: motoboy } = await supabase.from('motoboys').select('id').eq('user_id', userId).maybeSingle();
    if (!motoboy) {
      console.log(`Criando motoboy ${m.name}...`);
      const { data: criado, error: criaErro } = await supabase
        .from('motoboys')
        .insert({
          user_id: userId,
          name: m.name,
          email: m.email,
          status_plataforma: 'aprovado',
          aprovado_em: new Date().toISOString(),
          precisa_completar_cadastro: false,
          veiculo_tipo: 'moto',
        })
        .select('id')
        .single();
      if (criaErro) throw criaErro;
      motoboy = criado;
    } else {
      console.log(`Motoboy ${m.name} já existe (id ${motoboy.id}).`);
    }

    for (const loja of lojas) {
      const { data: afiliacao } = await supabase
        .from('motoboy_estabelecimentos')
        .select('id, status')
        .eq('motoboy_id', motoboy.id)
        .eq('restaurant_id', loja.id)
        .maybeSingle();

      if (!afiliacao) {
        await supabase.from('motoboy_estabelecimentos').insert({
          motoboy_id: motoboy.id,
          restaurant_id: loja.id,
          status: 'aceito',
          respondido_em: new Date().toISOString(),
        });
        console.log(`  -> afiliado a "${loja.name}"`);
      } else if (afiliacao.status !== 'aceito') {
        await supabase.from('motoboy_estabelecimentos').update({ status: 'aceito', respondido_em: new Date().toISOString() }).eq('id', afiliacao.id);
        console.log(`  -> afiliação com "${loja.name}" atualizada pra aceito`);
      }
    }

    console.log(`  -> login: ${m.email} / ${SENHA}`);
  }

  console.log('\nMotoboys de teste prontos.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Falha ao criar motoboys de teste:', err);
    process.exit(1);
  });

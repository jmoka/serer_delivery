// Roda UMA VEZ na primeira instalação em máquina de cliente: cria dados mínimos
// pro sistema funcionar de cara (admin, dono de restaurante teste, cliente teste,
// produtos, impressora, garçom). Idempotente — se o admin de teste já existe, não faz nada.
//
// Uso: npm run seed:primeiro-boot   (dentro de server_delivery, com .env configurado)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcryptjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const ADMIN_EMAIL = 'admin@delivery.com';
const ADMIN_SENHA = 'Jota1@@jota1979';
const RESTO_EMAIL = 'resto@delivery.com';
const RESTO_SENHA = '1234567';
const CLIENTE_EMAIL = 'usuario@delivery.com';
const CLIENTE_SENHA = '123456';
const GARCOM_LOGIN_KEY = 'TESTE001';
const GARCOM_SENHA = '123456';

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
  const { data: adminExistente } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle();

  if (adminExistente) {
    console.log('Seed de primeiro boot já rodou antes (admin de teste existe). Nada a fazer.');
    return;
  }

  console.log('Criando usuários de teste...');
  const adminId = await getOrCreateAuthUser(ADMIN_EMAIL, ADMIN_SENHA, 'Admin Teste', 'admin');
  const restoId = await getOrCreateAuthUser(RESTO_EMAIL, RESTO_SENHA, 'Dono Teste', 'restaurant_owner');
  await getOrCreateAuthUser(CLIENTE_EMAIL, CLIENTE_SENHA, 'Cliente Teste', 'customer');

  // Admin de teste tem senha fixa e conhecida — obriga trocar no 1º login.
  await supabase.from('user_profiles').update({ must_change_password: true }).eq('id', adminId);

  console.log('Criando restaurante de teste...');
  const { data: tipoRestaurante } = await supabase
    .from('establishment_types')
    .select('id')
    .eq('name', 'Restaurante')
    .maybeSingle();

  const { data: restaurante, error: restauranteErro } = await supabase
    .from('restaurants')
    .insert({
      name: 'Restaurante Teste',
      address: 'Rua Exemplo, 123 - São Paulo/SP',
      comissao_pct: 5.0,
      user_id: restoId,
      type_id: tipoRestaurante?.id ?? null,
    })
    .select('id')
    .single();
  if (restauranteErro) throw restauranteErro;
  const restauranteId = restaurante.id;

  console.log('Criando categoria e produtos de teste...');
  const { data: categoria, error: categoriaErro } = await supabase
    .from('categories')
    .insert({ name: 'Lanches', restaurant_id: restauranteId })
    .select('id')
    .single();
  if (categoriaErro) throw categoriaErro;

  const { error: produtosErro } = await supabase.from('products').insert([
    {
      name: 'X-Burguer',
      description: 'Hambúrguer artesanal com queijo',
      price: 25.9,
      category_id: categoria.id,
      restaurant_id: restauranteId,
      quantidade_estoque: 50,
    },
    {
      name: 'Batata Frita',
      description: 'Porção individual crocante',
      price: 12.0,
      category_id: categoria.id,
      restaurant_id: restauranteId,
      quantidade_estoque: 50,
    },
    {
      name: 'Refrigerante Lata',
      description: 'Lata 350ml',
      price: 6.0,
      category_id: categoria.id,
      restaurant_id: restauranteId,
      quantidade_estoque: 50,
    },
  ]);
  if (produtosErro) throw produtosErro;

  console.log('Criando impressora de teste...');
  const { error: impressoraErro } = await supabase.from('impressoras').insert({
    restaurant_id: restauranteId,
    nome: 'Impressora Cozinha',
    setor: 'cozinha',
    tipo_conexao: 'rede',
    ativo: true,
  });
  if (impressoraErro) throw impressoraErro;

  console.log('Criando garçom de teste...');
  const senhaHashGarcom = await bcrypt.hash(GARCOM_SENHA, 10);
  const { error: garcomErro } = await supabase.from('garcons').insert({
    restaurant_id: restauranteId,
    nome: 'Garçom Teste',
    login_key: GARCOM_LOGIN_KEY,
    password_hash: senhaHashGarcom,
    ativo: true,
    permissoes: { pagamento_parcial: true },
  });
  if (garcomErro) throw garcomErro;

  console.log('\nSeed de primeiro boot concluído.\n');
  console.log('Credenciais de teste:');
  console.log(`  Admin:      ${ADMIN_EMAIL} / ${ADMIN_SENHA}  (troca de senha obrigatória no 1º login)`);
  console.log(`  Dono resto: ${RESTO_EMAIL} / ${RESTO_SENHA}`);
  console.log(`  Cliente:    ${CLIENTE_EMAIL} / ${CLIENTE_SENHA}`);
  console.log(`  Garçom:     login "${GARCOM_LOGIN_KEY}" / senha "${GARCOM_SENHA}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Falha no seed de primeiro boot:', err);
    process.exit(1);
  });

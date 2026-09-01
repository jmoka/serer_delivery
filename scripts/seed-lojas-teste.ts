// Cria lojas de teste extras (Farmácia e Material de Construção) pra testar o
// sistema com tipos de estabelecimento diferentes de "Restaurante" — ex: nav
// mostra "Entregadores" em vez de "Motoboys" (ver useTipoRestaurante), módulo
// Salão nunca aparece pra esses tipos. Idempotente — se a loja já existe, pula.
//
// Uso: npm run seed:lojas-teste   (dentro de server_delivery, com .env configurado)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LOJAS = [
  {
    tipoNome: 'Farmácia',
    email: 'farmacia@delivery.com',
    senha: '123456',
    nomeDono: 'Dono Farmácia Teste',
    nomeLoja: 'Farmácia Teste',
    endereco: 'Av. Farmácia, 100 - São Paulo/SP',
    categoria: 'Medicamentos',
    produtos: [
      { name: 'Dipirona 500mg', description: 'Caixa com 10 comprimidos', price: 8.9 },
      { name: 'Soro Fisiológico 250ml', description: 'Frasco', price: 6.5 },
      { name: 'Álcool em Gel 70% 500ml', description: 'Frasco com válvula', price: 12.0 },
    ],
  },
  {
    tipoNome: 'Material de Construção',
    email: 'material@delivery.com',
    senha: '123456',
    nomeDono: 'Dono Material Teste',
    nomeLoja: 'Material de Construção Teste',
    endereco: 'Rua da Obra, 200 - São Paulo/SP',
    categoria: 'Ferramentas',
    produtos: [
      { name: 'Cimento 50kg', description: 'Saco', price: 34.9 },
      { name: 'Martelo Unha 25mm', description: 'Cabo de fibra', price: 29.9 },
      { name: 'Furadeira de Impacto 550W', description: '127V', price: 189.9 },
    ],
  },
];

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

async function garantirPlanoTeste() {
  const NOME_PLANO_TESTE = 'Plano Teste';
  const { data: existente, error: buscaErro } = await supabase
    .from('planos')
    .select('id, inclui_delivery, inclui_salao')
    .eq('nome', NOME_PLANO_TESTE)
    .maybeSingle();
  if (buscaErro) throw buscaErro;
  if (existente) return existente;

  const { data: criado, error: criaErro } = await supabase
    .from('planos')
    .insert({
      nome: NOME_PLANO_TESTE,
      valor: 49.9,
      periodicidade: 'mensal',
      tipo: 'saas',
      trial_dias: 30,
      ativo: true,
      inclui_delivery: true,
      inclui_salao: true,
    })
    .select('id, inclui_delivery, inclui_salao')
    .single();
  if (criaErro) throw criaErro;
  return criado;
}

async function main() {
  const planoTeste = await garantirPlanoTeste();

  for (const loja of LOJAS) {
    const { data: jaExiste } = await supabase.from('restaurants').select('id').eq('name', loja.nomeLoja).maybeSingle();
    if (jaExiste) {
      console.log(`"${loja.nomeLoja}" já existe (id ${jaExiste.id}). Pulando.`);
      continue;
    }

    const { data: tipo } = await supabase.from('establishment_types').select('id').eq('name', loja.tipoNome).maybeSingle();
    if (!tipo) throw new Error(`Tipo de estabelecimento "${loja.tipoNome}" não encontrado em establishment_types`);

    console.log(`Criando ${loja.nomeLoja}...`);
    const donoId = await getOrCreateAuthUser(loja.email, loja.senha, loja.nomeDono, 'restaurant_owner');

    const { data: restaurante, error: restauranteErro } = await supabase
      .from('restaurants')
      .insert({
        name: loja.nomeLoja,
        address: loja.endereco,
        comissao_pct: 5.0,
        user_id: donoId,
        type_id: tipo.id,
      })
      .select('id')
      .single();
    if (restauranteErro) throw restauranteErro;
    const restauranteId = restaurante.id;

    const { data: categoria, error: categoriaErro } = await supabase
      .from('categories')
      .insert({ name: loja.categoria, restaurant_id: restauranteId })
      .select('id')
      .single();
    if (categoriaErro) throw categoriaErro;

    const { error: produtosErro } = await supabase.from('products').insert(
      loja.produtos.map((p) => ({ ...p, category_id: categoria.id, restaurant_id: restauranteId, quantidade_estoque: 50 })),
    );
    if (produtosErro) throw produtosErro;

    const agora = new Date();
    const trialFim = new Date(agora);
    trialFim.setDate(trialFim.getDate() + 30);

    const { error: assinaturaErro } = await supabase.from('assinaturas').insert({
      restaurant_id: restauranteId,
      plano_id: planoTeste.id,
      status: 'trial',
      data_inicio: agora.toISOString(),
      trial_fim: trialFim.toISOString(),
      ultimo_periodo_faturado_fim: trialFim.toISOString(),
    });
    if (assinaturaErro) throw assinaturaErro;

    // Mesma sincronização que atribuirAssinatura() faria em produção — sem isso a
    // loja não aparece no marketplace nem libera carrinho (filtro modulo_delivery).
    const { error: moduloErro } = await supabase
      .from('restaurants')
      .update({ modulo_delivery: planoTeste.inclui_delivery, modulo_salao: false })
      .eq('id', restauranteId);
    if (moduloErro) throw moduloErro;

    console.log(`  -> login: ${loja.email} / ${loja.senha}`);
  }

  console.log('\nLojas de teste prontas.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Falha ao criar lojas de teste:', err);
    process.exit(1);
  });

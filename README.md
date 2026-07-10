# Delivery Base — Backend NestJS

API REST + MCP Server para plataforma de delivery white-label multi-tenant.

## Arquitetura do projeto

Este backend foi separado do frontend e vive em repositório próprio. A stack completa tem três partes independentes:

| Parte      | Repositório                                              | Onde roda                                   |
|------------|-----------------------------------------------------------|----------------------------------------------|
| Frontend   | `deliveryhub_white_label` (Vite + React)                  | `C:\Users\Micro\3D Objects\DEV\deliveryhub_white_label` |
| Backend    | `server_delivery` (este repo, NestJS)                      | `C:\Users\Micro\3D Objects\DEV\server_delivery`         |
| Banco      | Supabase (Postgres + Auth + Storage)                       | local via Supabase CLI (dev) ou hospedado (produção) |

Os três se comunicam por variáveis de ambiente (URLs + chaves) — nenhum depende de estar dentro da pasta do outro.

## Stack

- NestJS 11 + TypeScript
- Supabase (PostgreSQL)
- PagBank API v4 (PIX + cartão)
- MCP Server (Claude Code integration)

---

## Instalação local (desenvolvimento)

O `config.toml` do Supabase (portas customizadas 5433x) vive dentro do repo do **frontend**, em `deliveryhub_white_label/supabase/`. É de lá que o Supabase local é iniciado, mesmo estando o backend em outra pasta.

```bash
# 1. Clonar os dois repos lado a lado (mesma pasta pai)
#    DEV/deliveryhub_white_label
#    DEV/server_delivery

# 2. Subir o Supabase local (a partir do repo do frontend)
cd deliveryhub_white_label
supabase start
# Anota a API URL e a service_role key que aparecem no output
# (ou rode "supabase status" depois se já estiver rodando)

# 3. Instalar e configurar o backend
cd ../server_delivery
npm install
cp .env.example .env
# Edita o .env com os valores do passo 2:
#   SUPABASE_URL=http://127.0.0.1:54331
#   SUPABASE_SERVICE_ROLE_KEY=<service_role do supabase start>

# 4. Aplicar migrations (a partir do repo do frontend, onde ficam as migrations)
cd ../deliveryhub_white_label
supabase migration up

# 5. Iniciar o backend
cd ../server_delivery
npm run start:dev
# Sobe em http://localhost:3002

# 6. Iniciar o frontend
cd ../deliveryhub_white_label
npm install
cp .env.example .env
# Edita o .env do frontend com VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
# (mesmos valores do supabase start, chave anon/publishable)
npm run dev
# Sobe em http://localhost:4028
```

O Vite (`vite.config.mjs`) já tem proxy configurado: chamadas para `/api/*` no frontend são redirecionadas para `http://localhost:3002` (o backend), e chamadas para `/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1` vão direto para o Supabase local. Em desenvolvimento local isso é automático — não precisa configurar nada extra.

Variáveis obrigatórias no `.env` do backend:

```env
SUPABASE_URL=http://127.0.0.1:54331
SUPABASE_SERVICE_ROLE_KEY=<chave do supabase start>
PORT=3002
PAGBANK_TOKEN=<token do painel PagBank>
PAGBANK_SANDBOX=true
PAGBANK_WEBHOOK_URL=http://localhost:3002/pagamentos/webhook
```

### Portas (desenvolvimento local)

| Serviço       | Porta |
|---------------|-------|
| Frontend      | 4028  |
| Backend HTTP  | 3002  |
| Supabase API  | 54331 |
| Supabase DB   | 54332 |
| Supabase Studio | 54333 |

---

## Deploy em produção (VPS)

Em produção, backend e frontend rodam em processos/domínios separados — não existe mais o proxy do Vite, então cada um precisa apontar explicitamente para os endereços reais.

### 1. Provisionar o Supabase

Duas opções, escolha uma:

**Opção A — Supabase Cloud (hospedado, mais simples de manter):**
1. Criar um projeto em [supabase.com](https://supabase.com).
2. Rodar as migrations do projeto (`supabase/migrations/`) contra esse projeto (`supabase link` + `supabase db push`, ou colar o SQL direto no SQL Editor do painel).
3. Em **Project Settings → API**, pegar: `Project URL`, `anon public key` e `service_role key`.

**Opção B — Supabase self-hosted na própria VPS (Docker):**
1. Instalar Docker + Docker Compose na VPS.
2. Subir a stack self-hosted do Supabase (docker-compose oficial do Supabase, ou `supabase start` apontando pra um projeto configurado pra produção).
3. Aplicar as migrations (`supabase migration up` ou `supabase db push` contra a instância da VPS).
4. Pegar `API URL` (endereço público/domínio da VPS + porta configurada) e as chaves `anon` / `service_role` geradas na própria configuração.

Em ambas as opções, o que sai desse passo são 3 valores: **URL**, **anon key** e **service_role key**.

### 2. Configurar o backend (este repo) na VPS

```bash
git clone git@github.com:jmoka/serer_delivery.git
cd serer_delivery
npm install
npm run build
cp .env.example .env
```

Editar o `.env` com as credenciais do passo 1 e os dados reais de produção:

```env
SUPABASE_URL=<Project URL ou URL pública da VPS>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
PORT=3002
PAGBANK_TOKEN=<token de produção do PagBank>
PAGBANK_SANDBOX=false
PAGBANK_WEBHOOK_URL=https://SEU_DOMINIO/pagamentos/webhook
```

Rodar com `npm run start:prod` (idealmente atrás de um process manager como PM2, para reiniciar sozinho em caso de queda):

```bash
pm2 start dist/main.js --name delivery-backend
```

### 3. Configurar o frontend (`deliveryhub_white_label`) apontando pra produção

No `.env` de produção do frontend:

```env
VITE_SUPABASE_URL=<mesma Project URL do passo 1>
VITE_SUPABASE_ANON_KEY=<anon key do passo 1>
```

**Atenção — ponto pendente:** hoje o frontend chama o backend com caminhos relativos fixos (`fetch('/api/...')`), que só funcionam em desenvolvimento por causa do proxy do Vite. Em produção, com backend em domínio/porta separado, isso exige uma das duas soluções:

- Configurar um reverse proxy (nginx/Apache no cPanel ou na VPS) que roteie `/api/*` do domínio do frontend para o processo Node do backend (porta 3002); **ou**
- Ajustar o frontend para usar uma URL de API absoluta configurável via variável de ambiente (ex. `VITE_API_URL`), ainda não implementado.

Esse ajuste está registrado como pendência técnica e precisa ser resolvido antes do primeiro deploy real em produção.

---

## Endpoints — Testes com curl

> Substitua `TOKEN` pelo JWT de um usuário admin (obtenha via Supabase Studio → Auth → Users).

### Empresas (admin)

```bash
# Listar empresas
curl http://localhost:3002/empresas \
  -H "Authorization: Bearer TOKEN"

# Buscar empresa com métricas
curl http://localhost:3002/empresas/1 \
  -H "Authorization: Bearer TOKEN"

# Criar empresa
curl -X POST http://localhost:3002/empresas \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pizzaria Top","address":"Av. Paulista, 100","comissao_pct":5}'

# Atualizar comissão
curl -X PATCH http://localhost:3002/empresas/1 \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comissao_pct":7.5}'

# Remover empresa
curl -X DELETE http://localhost:3002/empresas/1 \
  -H "Authorization: Bearer TOKEN"
```

### Categorias

```bash
# Listar categorias da empresa 1
curl http://localhost:3002/empresas/1/categorias \
  -H "Authorization: Bearer TOKEN"

# Criar categoria
curl -X POST http://localhost:3002/categorias \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pizzas","restaurant_id":1}'

# Atualizar
curl -X PATCH http://localhost:3002/categorias/1 \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pizzas Especiais"}'

# Remover
curl -X DELETE http://localhost:3002/categorias/1 \
  -H "Authorization: Bearer TOKEN"
```

### Produtos

```bash
# Listar produtos da empresa 1
curl "http://localhost:3002/empresas/1/produtos" \
  -H "Authorization: Bearer TOKEN"

# Apenas ativos
curl "http://localhost:3002/empresas/1/produtos?apenas_ativos=true" \
  -H "Authorization: Bearer TOKEN"

# Criar produto
curl -X POST http://localhost:3002/produtos \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pizza Margherita","price":45.90,"category_id":1}'

# Ativar/desativar produto
curl -X PATCH http://localhost:3002/produtos/1/toggle \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ativo":false}'

# Atualizar preço
curl -X PATCH http://localhost:3002/produtos/1 \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"price":49.90}'
```

### Pedidos

```bash
# Criar pedido (cliente autenticado)
curl -X POST http://localhost:3002/pedidos \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "restaurant_id": 1,
    "payment_method": "pix",
    "itens": [
      {"product_id": 1, "quantity": 2},
      {"product_id": 2, "quantity": 1}
    ]
  }'

# Buscar pedido com itens e cliente
curl http://localhost:3002/pedidos/1 \
  -H "Authorization: Bearer TOKEN"

# Listar pedidos da empresa 1 (admin)
curl "http://localhost:3002/pedidos?empresa_id=1&status=pending" \
  -H "Authorization: Bearer TOKEN"

# Atualizar status (admin) — ao marcar delivered, comissão é registrada automaticamente
curl -X PATCH http://localhost:3002/pedidos/1/status \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"confirmed"}'

curl -X PATCH http://localhost:3002/pedidos/1/status \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"delivered"}'
```

### Pagamentos (PagBank)

```bash
# Gerar PIX para pedido
curl -X POST http://localhost:3002/pagamentos/pix \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": 1,
    "customer": {
      "name": "João Silva",
      "email": "joao@email.com",
      "tax_id": "123.456.789-00"
    }
  }'

# Pagar com cartão (card_encrypted vem do PagBank.js no frontend)
curl -X POST http://localhost:3002/pagamentos/cartao \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": 1,
    "customer": {"name":"João Silva","email":"joao@email.com","tax_id":"12345678900"},
    "card_encrypted": "TOKEN_DO_PAGBANK_JS",
    "parcelas": 1,
    "tipo": "CREDIT_CARD"
  }'

# Consultar pagamentos do pedido
curl http://localhost:3002/pagamentos/pedido/1 \
  -H "Authorization: Bearer TOKEN"

# Simular webhook PagBank (PAID) — sem auth
curl -X POST http://localhost:3002/pagamentos/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "id": "ORD_PAGBANK_123",
    "charges": [{
      "id": "CHG_456",
      "status": "PAID",
      "amount": {"value": 4590, "fees": {"value": 130}},
      "paid_at": "2026-06-05T10:00:00Z"
    }]
  }'
```

### Plataforma (dev-admin)

```bash
# Dashboard global: faturamento, comissões, top empresas
curl http://localhost:3002/plataforma/metricas \
  -H "Authorization: Bearer TOKEN"

# Listar todas as comissões
curl http://localhost:3002/plataforma/comissoes \
  -H "Authorization: Bearer TOKEN"

# Filtrar por empresa e período
curl "http://localhost:3002/plataforma/comissoes?empresa_id=1&data_inicio=2026-06-01&data_fim=2026-06-30" \
  -H "Authorization: Bearer TOKEN"

# Comissões detalhadas por empresa
curl http://localhost:3002/plataforma/comissoes/empresa/1 \
  -H "Authorization: Bearer TOKEN"
```

---

## MCP Server (Claude Code)

Após build, Claude Code detecta automaticamente via `.mcp.json` na raiz do projeto.

```bash
npm run build
# Claude Code reinicia → 8 tools disponíveis:
# listar_empresas, buscar_empresa, listar_comissoes
# listar_pedidos, buscar_pedido, estatisticas_pedidos
# listar_produtos, listar_categorias
```

## Fluxo de Comissão

```
POST /pedidos → pedido criado (status: pending)
POST /pagamentos/pix → PIX gerado
[cliente paga]
POST /pagamentos/webhook (PAID) → orders.status = 'confirmed'
PATCH /pedidos/:id/status { status: "delivered" }
  → trigger PostgreSQL on_order_delivered
  → INSERT plataforma_comissoes (comissao_valor = total * comissao_pct / 100)
GET /plataforma/comissoes → ver comissão registrada
```

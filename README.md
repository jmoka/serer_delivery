# Delivery Base — Backend NestJS

API REST + MCP Server para plataforma de delivery white-label multi-tenant.

## Stack

- NestJS 11 + TypeScript
- Supabase (PostgreSQL local porta 54331)
- PagBank API v4 (PIX + cartão)
- MCP Server (Claude Code integration)

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Copiar e preencher variáveis
cp .env.example .env

# 3. Iniciar Supabase local (na pasta delivery-base/)
cd .. && supabase start

# 4. Aplicar migrations
supabase migration up

# 5. Iniciar backend
npm run start:dev
```

Variáveis obrigatórias no `.env`:

```env
SUPABASE_URL=http://127.0.0.1:54331
SUPABASE_SERVICE_ROLE_KEY=<chave do supabase start>
PAGBANK_TOKEN=<token do painel PagBank>
PAGBANK_SANDBOX=true
PAGBANK_WEBHOOK_URL=http://localhost:3002/pagamentos/webhook
```

## Portas

| Serviço       | Porta |
|---------------|-------|
| Backend HTTP  | 3002  |
| Supabase API  | 54331 |
| Studio        | 54333 |
| Postgres      | 54332 |

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

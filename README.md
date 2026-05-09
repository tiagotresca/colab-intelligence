# colab-intelligence

Camada de inteligência da Colab Ventures. Ingere dados de performance dos negócios das portfolio companies (Luky Dog, A Quinta, O Passe, Physiohub, etc.), sintetiza em contexto accionável, e serve esse contexto via MCP para o agente do [work.colab](https://work.colab-ventures.com) gerar tarefas automáticas com inputs prontos a executar.

## Vision

End goal: o agente do work.colab cria semanalmente 3-5 propostas de tarefas com inputs concretos — ganchos para criativos Meta, temas e linhas de assunto para emails Klaviyo, fluxos de follow-up no WhatsApp, briefs para landing pages — baseadas no estado real do negócio de cada empresa.

Para isso este projecto faz três coisas distintas:

1. **Ingest** — ETL agendado puxa dados raw dos canais (Shopify, Meta Ads, Klaviyo, GA4, WhatsApp, blog) por empresa, normaliza e guarda.
2. **Synthesize** — transforma raw em **artefactos accionáveis pré-computados**: KPIs derivados, library de criativos vencedores com embeddings, snapshots periódicos do estado do negócio, anomaly/opportunity flags.
3. **Serve** — expõe MCP tools que devolvem contexto **decision-ready** (não dumps): `<2k tokens` por tool, JSON estruturado, sem o agente ter de re-sumarizar.

## Arquitetura (resumida)

```
┌────────────────────┐
│   Canais externos  │ Shopify, Meta Ads, Klaviyo, GA4, WhatsApp, Blog
└─────────┬──────────┘
          ↓
┌────────────────────┐
│   Ingest (cron)    │ /api/ingest/*  — ETL idempotente, retomável, partitioned
└─────────┬──────────┘
          ↓
┌────────────────────┐
│  Synthesize layer  │ KPIs derivados, embeddings, snapshots, signals
└─────────┬──────────┘
          ↓
┌────────────────────┐    MCP    ┌────────────────────┐
│   Serve (MCP HTTP) │ ◄───────► │   work.colab agent │
└────────────────────┘           └────────────────────┘
          ▲                                │
          │              creates drafts    │
          │   ┌─────────────────────────────┘
          │   ▼
┌────────────────────┐
│ Autonomous agent   │ /api/agent/*  — cron, server-side Anthropic API
│ (cria task_drafts) │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│   work.colab MCP   │ push de drafts para tasks pendentes (bidirecional)
└────────────────────┘
```

## Phasing (8 semanas)

**Fase 1 — esqueleto (semanas 1-2)**
- Repo + Supabase próprio + pgvector
- Schema base aplicado ([sql/0001-init.sql](sql/0001-init.sql))
- ETL de Shopify (incremental, daily) → kpi_snapshots
- 1ª MCP tool: `get_business_health(empresa_id)`
- Agente do work.colab consome esta tool num botão "Diagnóstico" para validar a interface

**Fase 2 — abrangência (semanas 3-5)**
- Acrescenta Meta Ads + Klaviyo + GA4
- Constroi creative library com embeddings (puxar criativos passados + outcomes)
- 3-4 MCP tools especializadas: `propose_email_brief`, `propose_meta_creative_brief`, `propose_wa_flow`

**Fase 3 — autonomia (semanas 6-8)**
- Cron "insights agent" detecta oportunidades + cria draft em pendentes do work.colab via MCP
- Eval loop: tracking de aceitação/edição/outcome
- 1ª iteração de patterns/recommendations baseada nos primeiros outcomes

## Stack

- **Runtime:** Vercel Functions (Fluid Compute, Node 24)
- **DB:** Supabase Postgres + pgvector
- **Language:** TypeScript
- **MCP:** HTTP transport
- **AI:** Anthropic API direct (Claude Opus 4.7) para o agente autónomo; embeddings via Voyage ou OpenAI

## Eval loop (não-negociável)

Cada draft auto-gerado guarda:
- `draft_version` (qual prompt/template) + `context_bundle_id` (qual contexto)
- Aceitação: `as_is` | `edited_lightly` | `edited_heavily` | `rejected` + diff
- Outcome metrics depois da execução (CTR, open rate, conversões)

Métrica chave: **% de drafts aceites sem edição pesada** + **outcome lift vs baseline**.

## Setup local

```bash
npm install
cp .env.example .env.local  # preenche os valores
# aplicar schema no Supabase Dashboard
psql "$DATABASE_URL" -f sql/0001-init.sql
npm run dev
```

## Estrutura

```
colab-intelligence/
├── api/
│   ├── mcp.ts              # Servidor MCP HTTP (todas as tools)
│   ├── ingest/             # ETL crons por canal
│   │   └── shopify.ts
│   └── agent/              # Agente autónomo (Fase 3)
├── lib/
│   ├── supabase.ts
│   └── types.ts
├── sql/
│   └── 0001-init.sql
└── docs/
    └── architecture.md
```

## Repos relacionados

- **work.colab** ([github.com/tiagotresca/work.colab](https://github.com/tiagotresca/work.colab)) — dashboard de operação. Consome este MCP. Source of truth para `empresas` (table referenciada aqui).

# colab-intelligence — instructions for Claude

> Camada de inteligência da Colab Ventures. Sintetiza dados de performance dos negócios das portfolio companies → serve via MCP ao agente do [work.colab](https://github.com/tiagotresca/work.colab).
>
> **Repo irmão:** [`~/Desktop/Work-Colab`](~/Desktop/Work-Colab) (work.colab dashboard).

## Mission

Não é um data warehouse — é uma **intelligence layer**. Cada output deve ser **decision-ready**, não raw. Se uma MCP tool devolve mais de 2k tokens, está a fazer mal o seu trabalho — devia estar a sumarizar/sintetizar.

Três jobs distintos:
1. **Ingest** (cron, dumb): puxa raw, normaliza, guarda. Idempotente.
2. **Synthesize** (a parte difícil): KPIs derivados, embeddings, snapshots, signals. Pré-computado.
3. **Serve** (MCP): tools devolvem JSON estruturado pronto para um agente decidir.

## Stack

- **Runtime:** Vercel Functions (Fluid Compute, Node 24 LTS)
- **DB:** Supabase Postgres + pgvector (separado do work.colab — operacional vs analítico têm perfis diferentes)
- **Language:** TypeScript estrito
- **MCP transport:** HTTP
- **AI:** Anthropic API direct para agente autónomo; embeddings via Voyage/OpenAI

## Convenções

- Commits em PT, formato `Área — descrição` (igual ao work.colab).
- TypeScript estrito (`"strict": true`); preferir tipos discriminados sobre `any`.
- Migrations em `sql/NNNN-description.sql`, aplicadas manualmente no Supabase Dashboard. Sem migration runner.
- Cada MCP tool num ficheiro próprio em `api/mcp/tools/` com schema Zod + handler tipado.
- Cada ETL channel num ficheiro próprio em `api/ingest/`. Schedule via `vercel.json` crons.
- ETL é **idempotente** (re-run não duplica) e **retomável** (track via `etl_runs`).

## Não fazer

- **Não** misturar dados operacionais aqui (tasks, comments, equipa). Source of truth para isso é o work.colab.
- **Não** expor service-role key ao cliente. MCP server é server-side.
- **Não** retornar raw data nas MCP tools — sintetizar primeiro. Se a feature não cabe em <2k tokens, cria-se uma tool mais específica.
- **Não** correr o agente autónomo sem cap de tokens / iterações. Server-side é responsabilidade nossa, não há "user paga".

## Workflow de deploy (a definir após primeiro push)

Esperado seguir padrão do work.colab:
- Branch `main` → produção
- Branch `staging` → preview testável (URL fixa)
- Working branches → preview Vercel auto

Confirmar com o Tiago antes do primeiro push para qualquer branch protegida.

## Currentdate

Hoje é 2026-05-09. Início do projecto.

## Decisões já tomadas

- **Nome:** `colab-intelligence`
- **Localização:** `~/Desktop/colab-intelligence/`
- **Supabase próprio** (não partilha com work.colab) — operacional vs analítico
- **Phasing:** 8 semanas, ver `README.md`
- **Primeiro canal de ingest:** Shopify (sinal mais limpo, ciclo curto de feedback)
- **Primeira MCP tool:** `get_business_health(empresa_id)`
- **Eval loop é mandatório** desde o dia 1

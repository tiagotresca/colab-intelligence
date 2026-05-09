# Architecture — colab-intelligence

> Decisões arquiteturais e o porquê delas. Documento vivo — actualizar
> quando uma decisão é tomada ou revertida.

## Princípios

1. **Decision-ready output, não raw.** Cada MCP tool devolve JSON estruturado pronto a usar pelo agente. Se ultrapassa 2k tokens, partir em tools mais específicas.
2. **Idempotência em tudo o que é cron.** Re-correr ETL não duplica.
3. **Eval loop é first-class.** Cada draft tem `draft_version` + `context_bundle_id`; outcome é trackado.
4. **Versionar contracts.** MCP tool outputs têm shape estável; mudanças → nova versão (`v2`) ou breaking flag.
5. **Cap de tokens no agente autónomo.** Server-side é responsabilidade da casa, não há "user paga".

## Por que não monolítico no work.colab?

- **Perfis de dados diferentes:** operacional (tasks, comments, equipa) é low-volume, alto realtime, escrita constante. Analítico é high-volume, batch, mostly-read.
- **Stack diferente:** dashboard é vanilla JS (legacy, mas funcional). Intelligence layer beneficia de TypeScript estrito + tipos discriminados.
- **Auth model diferente:** dashboard tem auth por user (magic link, RLS). MCP server é server-to-server.
- **Scaling diferente:** ETL pode crescer 100x; tasks crescem ~2x/ano.

## Por que não mesma Supabase?

- RLS apertada do work.colab seria barreira para queries analíticas cross-empresa.
- Backups: time-series enche a DB rápido — não queres recuperar uma DB de 50GB para restaurar uma comment perdido.
- Custos: Supabase compute/storage é separado por projecto, mais previsível.

## Stack escolhida

| Componente | Escolha | Alternativas consideradas |
|---|---|---|
| Runtime | Vercel Functions (Fluid) | AWS Lambda (mais setup), Railway (menos recente) |
| DB | Supabase Postgres + pgvector | Neon Postgres + pgvector (~igual), Pinecone (RAG only, evita) |
| Language | TypeScript estrito | Python (data tooling melhor mas extra deploy infra) |
| MCP transport | HTTP | stdio (não funciona em Vercel serverless) |
| Embeddings | Voyage voyage-3 (1024 dims) | OpenAI ada-002 (custa mais), Cohere embed |
| LLM (agente) | Anthropic Claude Opus 4.7 direct | AI Gateway (overkill v1) |

## Flow do agente autónomo (Fase 3)

```
cron (semanal)
  ↓
para cada empresa:
  ↓
  fetch business_snapshots[latest]
  ↓
  context_bundle = sintetizar (snapshot + creative library top-K + opportunities)
  ↓
  Anthropic API: "dá-me 3 propostas de tarefas com ganchos prontos"
  ↓
  validar payload (Zod)
  ↓
  guardar em task_drafts (status: pending)
  ↓
  push via work.colab MCP → tasks_pendentes
  ↓
  link draft_id ↔ work.colab task_id
```

## Eval loop

Cada `task_draft` traz:
- `draft_version` (qual prompt template usou)
- `context_bundle` (snapshot do contexto que entrou no LLM)
- `payload` (output do LLM)

Quando humano interage com a task no work.colab:
- Aceita as-is → `eval_outcomes.acceptance = 'as_is'`
- Edita ligeiramente (ex: muda título, mantém hooks) → `'edited_lightly'`
- Edita pesado (>50% do conteúdo muda) → `'edited_heavily'`
- Rejeita → `'rejected'`

Hook no work.colab (a definir): quando uma task com origem `auto:v1` é arquivada/aceite, manda webhook para `/api/eval/{draft_id}` aqui.

## Contracts entre work.colab e colab-intelligence

### work.colab → colab-intelligence (read-only, via MCP HTTP)
- `get_business_health(empresa_id)`
- `get_creative_brief_context(empresa_id, goal, audience)` (Fase 2)
- `find_similar_winners(channel, query)` (Fase 2)

### colab-intelligence → work.colab (write, via MCP HTTP)
- `create_task_draft(empresa_id, payload)` — cria task em pendentes com tag `auto:v1` (Fase 3)
- `register_outcome(task_id, outcome)` — webhook para eval loop

### Bidireccional (sync)
- `empresas` (id+name) — sync periódico do work.colab para aqui

## Open questions

- Onde guardar credenciais de canal por empresa? Hoje o work.colab tem `marketing_sources`. Repetir aqui ou expor via MCP do work.colab? **Decisão pendente.**
- Que provider de embedding? Voyage parece bom-preço/qualidade mas é extra account. **Decisão pendente para Fase 2.**
- Snapshots horários ou diários? Para Shopify start com diário; Meta Ads pode beneficiar de horário em campanhas activas.

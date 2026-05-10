# Vision docs

North star do colab-intelligence — o que estamos a construir a longo prazo. **Não é roadmap, é destino.**

Os prompts de vision foram criados em 2026-05-10 para articular o produto-final que esta intelligence layer deve permitir.

## Documentos

- [vision-growth-command-center.md](vision-growth-command-center.md) — UI/UX do "Growth Command Center" (14 páginas, dashboards, decision scoring, alertas)
- [vision-attribution-engine.md](vision-attribution-engine.md) — Customer Source Attribution + Customer Quality Engine (a base de dados que torna o GCC possível)

## Como ler estes docs

Estes prompts descrevem **o estado-alvo**, não o sprint corrente. Construir tudo à letra é 6-12 meses de trabalho.

Trade-off importante: a Vision do GCC depende da Vision de Attribution. Sem o Customer Quality Engine, qualquer página do GCC que avalie "qualidade de uma iniciativa" mostra blended ROAS/CAC — i.e. não responde verdadeiramente às 5 perguntas finais do GCC ("o crescimento é sustentável?", "que iniciativas destroem margem?").

Por isso a sequência canónica é:
1. **Attribution Engine primeiro** (Sprint 3+) — extrair UTMs/landing/discount_codes do que já temos no Shopify raw, depois Meta CAPI, depois COGS
2. **Customer Quality Engine** — synthesize agregando attribution + retention + margin
3. **Dashboard pages do GCC** — começar pelas que dão mais valor com os dados disponíveis (Cohorts, Initiatives, Overview), adiar as que dependem de attribution rica (Creative Intelligence, Landing Pages)
4. **Initiatives tracking layer** — em paralelo, registar manualmente o que se está a testar para fechar o loop com decision scoring

## Estado actual vs Vision

| Vision | O que temos hoje | Gap |
|---|---|---|
| LTV/CAC por criativo | CAC/ROAS blended (Meta spend ÷ Shopify new customers/revenue) | Sem matching ad_id↔customer (precisa Meta CAPI) |
| LTV/CAC por landing page | Nada | Sem capturing UTMs no order (extraível de Shopify payload) |
| LTV/CAC por discount code | Nada | Discount codes estão no payload — extraível |
| Cohort retention heatmap | Repeat rate diário | Dados existem em customers_raw, falta query/UI |
| Decision Score por iniciativa | Nada | Precisa initiatives layer + quality scoring |
| AI Growth Notes | Headline + signals básicos no `get_business_health` | Precisa MCP tools mais granulares + slash agent |
| Alert engine | 4 heurísticas em `get_business_health` | Precisa cron + persistência de alertas |
| Multi-channel ingest (Meta+Klaviyo+GA4+Google+TikTok) | Shopify + Meta Ads | Falta 4 canais |

## Build vs Buy

Decisão tomada (2026-05-10): **construir** mesmo havendo Triple Whale / Northbeam / Polar a $100-1000+/mês. Razão: controlo total para responder à evolução da AI ao longo do tempo + integração profunda com a plataforma do work.colab que vai evoluir muito também.

Trade-off aceite: 6-12 meses para chegar à vision vs 3-4 dias para uma das ferramentas comerciais cobrir 70% out-of-the-box.

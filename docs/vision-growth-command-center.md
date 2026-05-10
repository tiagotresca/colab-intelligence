# Vision — Growth Command Center

> Prompt de vision criado em 2026-05-10 para articular o produto-final do dashboard. **Estado-alvo, não sprint corrente.** Ver [README.md](README.md) para sequenciamento.

---

Quero que cries a interface de um dashboard chamado "Growth Command Center".

## Objetivo

Criar uma plataforma de gestão de growth para e-commerce/D2C que permita a um gestor ler rapidamente a performance do negócio e de cada iniciativa de crescimento.

A lógica central do dashboard deve ser baseada em dois grandes fatores:

1. Velocidade de crescimento
2. Relação CAC / LTV

O dashboard deve permitir analisar esses dois fatores por:
- Canal
- Campanha
- Criativo
- Landing page
- Blog post
- Promoção
- Teste A/B
- Iniciativa de CRM
- Cohort
- Produto
- Marca

A interface deve parecer um sistema operativo de decisão, não apenas um painel de reporting.

## Estrutura geral da interface

Layout SaaS moderno:
- Sidebar lateral fixa
- Top bar com filtros globais
- Área principal em cards
- Sistema modular
- Drill-down por iniciativa
- Tabelas inteligentes
- Gráficos limpos
- Estados visuais por cor
- Alertas automáticos
- Design premium, clean e executivo

Estética: moderna, minimalista, premium, clara, focada em decisão. Inspirada em Linear, Vercel, Stripe Dashboard, Retool, Metabase, Northbeam, Triple Whale.

## Navegação principal (sidebar)

1. Overview
2. Growth
3. Initiatives
4. Funnel
5. Creative Intelligence
6. Landing Pages
7. Campaigns
8. SEO / Content
9. Retention
10. Cohorts
11. Unit Economics
12. Alerts
13. Data Sources
14. Settings

## Top bar / filtros globais

- Brand selector
- Date range
- Channel selector
- Campaign selector
- Initiative type
- Country / market
- Device
- Customer type: new vs returning
- Product category

Botões: Refresh data, Export, Create Growth Note. Indicador de última atualização. Pesquisa global.

## Página 1: Overview

**Objetivo:** leitura executiva em 30 segundos.

Cards principais:
- Revenue MTD
- Revenue growth MoM
- New customers
- CAC blended
- LTV projected
- LTV/CAC ratio
- CAC payback
- MER
- Contribution margin
- Conversion rate
- AOV
- Returning customer rate
- Churn rate

Cada card: valor principal, variação vs período anterior, mini trendline, estado visual (verde/amarelo/vermelho).

Gráficos:
1. Revenue over time
2. CAC over time
3. LTV/CAC over time
4. New customers over time
5. MER over time
6. Contribution margin over time

Secção "Decision Alerts":
- CAC acima do target
- LTV/CAC abaixo de 3x
- Landing page com queda de conversão
- Criativo com sinais de fadiga
- Campanha com ROAS alto mas CAC mau
- Blog post com tráfego crescente mas baixa conversão
- Promoção com crescimento de revenue mas baixa margem

## Página 2: Growth

**Objetivo:** mostrar se o negócio está a crescer e o que está a causar esse crescimento.

- Revenue by channel
- New customers by channel
- Growth contribution by initiative
- Organic vs paid growth
- D2C vs marketplace vs retail
- Spend vs revenue
- Growth efficiency

**Growth Contribution Waterfall** — gráfico mostrando contribuição de cada canal/iniciativa para o crescimento.

Exemplo: Meta +€12k, Google +€8k, SEO +€4k, CRM +€6k, Promotions +€10k, Churn -€5k.

Tabela "Growth Drivers" — colunas: Driver, Type, Revenue contribution, New customers, CAC, LTV/CAC, Growth lift, Margin impact, Status, Recommended action. Status: Scale / Keep testing / Watch / Pause / Kill.

## Página 3: Initiatives

**A página mais importante.** Cada iniciativa de growth = unidade de análise.

Exemplos de iniciativas:
- Landing Page Test A
- Creative Test 14
- Blog Post "Alimentação Natural para Cães"
- Promo Março
- Email Winback
- WhatsApp Automation
- Influencer Campaign
- Google Search Campaign
- Meta UGC Batch
- Product Bundle Test

Cada iniciativa: Nome, Tipo, Canal, Owner, Start date, End date, Status, Spend, Revenue, New customers, CAC, LTV projected, LTV/CAC, Gross margin, Contribution margin, Growth lift, Confidence level, Recommended decision.

**Decision Score** (0-100) — combinação de:
- Growth impact
- CAC efficiency
- LTV/CAC
- Margin quality
- Statistical confidence
- Strategic relevance

Classificação:
- 80–100: Scale
- 60–79: Continue testing
- 40–59: Watch
- 20–39: Pause
- 0–19: Kill

### Detalhe da iniciativa (modal/page)

Header: nome, tipo, canal, owner, status, decision score, recomendação.

Cards: Spend, Revenue, CAC, LTV projected, LTV/CAC, CAC payback, Margin, Conversion rate, Growth lift.

Gráficos: Performance over time, Spend vs revenue, CAC trend, Funnel conversion, Cohort behaviour, Margin impact.

**AI Growth Notes** — insights automáticos:
- "Esta landing page melhorou a conversão em 18%, mas trouxe clientes com LTV 12% inferior."
- "O criativo tem CTR elevado, mas CAC acima do target. Provável problema na qualidade do tráfego."
- "A promoção gerou crescimento rápido, mas reduziu a margem de contribuição."

**Recommended Next Action**:
- Scale budget by 20%
- Create 3 new creative variations
- Pause after 48h if CAC remains above target
- Move to evergreen campaign
- Test offer without discount
- Create retention flow for acquired cohort

## Página 4: Funnel

**Objetivo:** detectar bottlenecks.

Traffic → Product View → Add to Cart → Checkout → Purchase → Repeat Purchase

Métricas: Sessions, CTR, Landing page CVR, Product page CVR, Add to cart rate, Checkout rate, Purchase CVR, Repeat purchase rate, Drop-off rate.

Funil horizontal. Breakdown por: Channel, Campaign, Landing page, Device, Customer type, Product.

Alertas: queda de CVR, aumento de drop-off, problema no checkout, mobile inferior ao desktop, alto tráfego com baixa intenção.

## Página 5: Creative Intelligence

**Objetivo:** analisar criativos.

Grid de criativos. Cada card: thumbnail, nome, plataforma, spend, impressions, CTR, CPC, CPM, hook rate, thumbstop ratio, CAC, ROAS, purchases, fatigue score, status.

Filtros: Platform, Campaign, Format, Hook type, Angle, Audience, Spend threshold, Status.

Tags: UGC, Testimonial, Founder story, Product demo, Problem/Solution, Promo, Educational, Comparison, Social proof.

Tabela "Creative Winners & Losers": Creative, Angle, Spend, CAC, CTR, CVR, Fatigue, Decision, Next variation to test.

Badges: "Winner" (verde), "Fatigue" (amarelo), "Kill" (vermelho).

## Página 6: Landing Pages

Tabela: Landing page, URL, Sessions, Source, Conversion rate, CAC, Revenue, AOV, Bounce rate, Scroll depth, Time on page, LTV projected, LTV/CAC, Winner status.

Gráficos: CVR over time, CAC by landing page, LTV/CAC by landing page.

**Landing Page Test Matrix**: Control, Variant A, B, C com CVR, CAC, Revenue per visitor, Confidence, Decision.

## Página 7: Campaigns

Tabela: Campaign, Platform, Objective, Spend, Revenue, New customers, CAC, ROAS, MER, LTV projected, LTV/CAC, Margin, Status, Recommendation.

Gráficos: Spend allocation, CAC by campaign, Revenue by campaign, New customers by campaign, Campaign efficiency matrix.

Matriz 2x2 (Eixo X = Growth impact, Eixo Y = Efficiency):
1. High growth / High efficiency = Scale
2. High growth / Low efficiency = Optimize
3. Low growth / High efficiency = Niche / Maintain
4. Low growth / Low efficiency = Kill

## Página 8: SEO / Content

Tabela: Content title, URL, Type, Publish date, Organic sessions, Ranking keywords, Leads generated, Purchases assisted, Revenue assisted, Conversion rate, CAC estimated, LTV/CAC, Growth contribution, Status.

Gráficos: Organic traffic over time, Assisted revenue by content, Content conversion rate, Top content by LTV/CAC.

Badges: Compounding, Needs update, High traffic / low conversion, Revenue driver, SEO opportunity.

## Página 9: Retention

- Repeat purchase rate
- Churn rate
- Active customers
- Reactivated customers
- Subscription retention
- Average days to second purchase
- LTV by source / cohort / product / landing page

Gráficos: Retention curve, Churn curve, Repeat purchase timeline, LTV accumulation curve, CAC payback curve.

Tabela "Customer Quality by Acquisition Source": Source, New customers, CAC, First order AOV, 30/60/90-day repeat rate, 90/180-day LTV, Projected LTV, LTV/CAC, Quality score.

## Página 10: Cohorts

Heatmap. Linhas = cohort mês de aquisição. Colunas = Month 0 a 12.

Métricas alternáveis: Revenue per customer, Retention %, Repeat purchase %, Gross margin, Contribution margin, LTV, Orders per customer.

Filtros: Source, Campaign, Product, Landing page, Promo, Customer type.

Gráficos: LTV by cohort over time, Payback by cohort, Retention by cohort.

## Página 11: Unit Economics

Cards: CAC, LTV, LTV/CAC, CAC payback, Gross margin, Contribution margin, COGS %, Shipping %, Payment fees %, Marketing %, Software %, Refunds %, Net margin.

**Unit Economics Waterfall**:
Revenue → -COGS → -Shipping → -Payment fees → -Discounts → -Marketing → -Software → = Contribution margin

Análise por: Product, Channel, Campaign, Cohort, Customer type.

## Página 12: Alerts

Feed com prioridades:

**Alta**: CAC acima do target 3 dias, LTV/CAC abaixo de 3x, checkout caiu >20%, campanha sem conversão, criativo com fadiga.

**Média**: landing page com tráfego alto e baixa conversão, blog post com tráfego sem conversão, promoção com margem baixa, source com clientes de baixa qualidade.

**Baixa**: criativo novo promissor, SEO page subindo, segmento melhorando.

Cada alerta: título, descrição, impacto estimado, métrica afetada, recomendação. Botões: Create task, Ignore, Mark as resolved.

## Página 13: Data Sources

Cards: Shopify, WooCommerce, GA4, Meta Ads, Google Ads, TikTok Ads, Klaviyo, HubSpot, WhatsApp CRM, Email platform, Payment provider, ERP, Custom CSV, BigQuery.

Cada fonte: Status, Last sync, Data health, Errors, Records imported.

## Componentes UI reutilizáveis

KPI Card, Metric Trend Card, Initiative Table, Initiative Detail Modal, Alert Card, Creative Card, Funnel Chart, Cohort Heatmap, Growth Waterfall Chart, Efficiency Matrix, Unit Economics Waterfall, Status Badge, Decision Score Badge, Filter Bar, Sidebar, Top Navigation, Data Source Card.

## Design system

Background: #0B0F14 (dark) ou #F8FAFC (light)
Cards: #111827 (dark) / #FFFFFF (light)
Texto primary: #F9FAFB / #111827
Texto secondary: #9CA3AF / #6B7280

Estados:
- Verde: Scale / Good
- Amarelo: Watch
- Vermelho: Kill / Critical
- Azul: Testing
- Roxo: Insight / AI

Tipografia: Inter. Headings fortes, labels pequenos, tabelas legíveis. Whitespace generoso.

## Lógica de decisão

Para cada iniciativa:

- **Growth Impact Score** — revenue contribution + new customers
- **Efficiency Score** — CAC vs target + LTV/CAC
- **Margin Score** — contribution margin
- **Confidence Score** — volume de dados/spend
- **Final Decision Score** — média ponderada

Score → Decisão:
- ≥80: Scale
- 60-79: Continue Testing
- 40-59: Watch
- 20-39: Pause
- <20: Kill

## Objetivo final da interface

A interface deve responder rapidamente a 5 perguntas:

1. O negócio está a crescer?
2. Está a crescer de forma lucrativa?
3. Quais iniciativas estão a gerar crescimento?
4. Quais iniciativas estão a destruir margem?
5. Onde devemos investir mais amanhã?

## Stack alvo

- React + TypeScript
- Tailwind CSS
- shadcn/ui
- Recharts
- TanStack Table
- Estrutura: /components, /data (mocks), /pages

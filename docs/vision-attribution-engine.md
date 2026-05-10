# Vision — Customer Source Attribution + Customer Quality Engine

> Prompt de vision criado em 2026-05-10. **Esta é a fundação para o [Growth Command Center](vision-growth-command-center.md).** Sem isto, o GCC mostra blended ROAS/CAC e não responde verdadeiramente a "qual iniciativa traz clientes melhores".

---

## Camada crítica: Customer Source Attribution

O sistema deve garantir que cada cliente adquirido tem uma origem rastreável, para permitir cruzar CAC/LTV por criativo, campanha, landing page, canal e iniciativa.

Sem esta camada, não é possível avaliar corretamente a qualidade real de uma estratégia, porque ROAS e CAC imediato não mostram se os clientes adquiridos têm bom LTV.

### Campos por cliente

- customer_id
- first_order_id
- first_purchase_date
- first_touch_source
- first_touch_medium
- first_touch_campaign
- first_touch_content
- first_touch_term
- last_touch_source
- last_touch_medium
- last_touch_campaign
- last_touch_content
- last_touch_term
- utm_source
- utm_medium
- utm_campaign
- utm_content
- utm_term
- landing_page_url
- referrer
- device
- country
- platform
- ad_account_id
- campaign_id
- campaign_name
- adset_id
- adset_name
- ad_id
- ad_name
- creative_id
- creative_name
- discount_code
- influencer_code
- affiliate_id
- whatsapp_entry_point
- quiz_id
- lead_form_id
- session_id
- anonymous_id
- attribution_model
- attribution_confidence

### Cruzamentos suportados

O sistema deve permitir cruzar performance por:

- Creative
- Ad
- Ad set
- Campaign
- Channel
- Landing page
- Blog post
- Promo code
- Influencer
- Affiliate
- WhatsApp entry point
- CRM flow
- First-touch source
- Last-touch source

## Customer Quality Engine

**Objetivo:** medir a qualidade dos clientes adquiridos por cada iniciativa.

### Métricas por origem

- New customers
- CAC
- First order AOV
- Gross margin first order
- Contribution margin first order
- 30-day repeat purchase rate
- 60-day repeat purchase rate
- 90-day repeat purchase rate
- 180-day LTV
- Projected LTV
- LTV/CAC
- CAC payback
- Churn rate
- Refund rate
- Discount dependency
- Subscription conversion rate
- Average orders per customer
- Margin-adjusted LTV

### Comparações

Tabelas e gráficos para comparar:

- LTV/CAC by creative
- LTV/CAC by campaign
- LTV/CAC by landing page
- LTV/CAC by promo
- LTV/CAC by influencer
- Retention by acquisition source
- Repeat purchase by first-touch source
- Margin-adjusted LTV by campaign

## Princípio fundamental

O dashboard nunca deve avaliar uma campanha apenas por ROAS ou CAC imediato.

Toda avaliação de performance deve cruzar:

1. Custo de aquisição
2. Qualidade do cliente adquirido
3. LTV projetado
4. Margem
5. Retenção

**Exemplo:** Um criativo pode ter CAC baixo, mas trazer clientes com LTV fraco. Outro criativo pode ter CAC mais alto, mas trazer clientes com maior retenção e maior margem.

A interface deve deixar isto claro visualmente.

### Alertas-tipo a gerar

- "Criativo com CAC baixo, mas LTV abaixo da média"
- "Campanha com CAC alto, mas melhor cohort de retenção"
- "Promoção gerou muitos clientes, mas com alta dependência de desconto"
- "Influencer trouxe poucos clientes, mas com LTV 2.3x superior à média"
- "Landing page converte bem, mas atrai clientes de baixa qualidade"

## Customer Attribution Data Model

```
Customer {
  id
  email_hash
  first_purchase_date
  first_order_value
  total_revenue
  gross_margin
  contribution_margin
  orders_count
  last_order_date
  churn_status
  subscription_status
  acquisition_source
  acquisition_medium
  acquisition_campaign
  acquisition_content
  acquisition_creative_id
  acquisition_ad_id
  acquisition_adset_id
  acquisition_landing_page
  acquisition_discount_code
  acquisition_influencer_code
  acquisition_whatsapp_entry_point
  first_touch
  last_touch
  attribution_confidence
  projected_ltv
  margin_adjusted_ltv
}
```

O sistema deve usar estes dados para calcular a performance real de cada iniciativa.

---

## Notas de implementação (não estavam no prompt original)

### O que é extraível do que já temos (Sprint 3 v1)

Shopify orders payload jsonb já contém:
- `landing_site` — primeira URL de landing (com query string e UTMs se passou por essa rota)
- `referring_site` — referrer externo
- `source_name` — `web` / `instagram` / `facebook` / `shopify_draft_order` / etc
- `discount_codes[]` — array de códigos aplicados (extraível para promo/influencer/affiliate code)
- `note_attributes[]` — alguns shops capturam UTMs aqui via tracking script
- `client_details.browser_ip`, `user_agent` — device

### O que requer instrumentação adicional

| Campo | Como obter |
|---|---|
| `creative_id`, `ad_id`, `adset_id`, `campaign_id` (Meta) | Meta Conversion API + matching via `fbp`/`fbc` cookies. Significativo. |
| `landing_page_url` rich (com SPA navigation) | Tracking script client-side a fazer write a `note_attributes` no checkout |
| `influencer_code` separado de `discount_code` | Mapping table manual em colab-intelligence |
| `affiliate_id` | Sistema de referral próprio (custom) |
| `whatsapp_entry_point` | Custom flag em `wa.me` links + capture no inbound |
| `quiz_id`, `lead_form_id` | Depende do tool de quiz/forms usado |
| `gross_margin` / `contribution_margin` | COGS por produto. Shopify tem `cost_per_item` se for preenchido. Senão, manual em colab-intelligence. |
| `projected_ltv` | Modelo simples (orders × AOV × retention curve) ou ML (futuro) |

### Sequenciamento sugerido

1. **v1 — extracção do existente** (Sprint 3): UTMs do landing_site, referring_site, discount_codes, source_name, device. ~70% de valor sem instrumentação nova.
2. **v2 — Meta CAPI** (Sprint posterior): matching ad_id↔customer. Resolve o gap mais doloroso ("LTV/CAC por creative").
3. **v3 — COGS + margem real** (Sprint posterior): Shopify cost_per_item ou manual table.
4. **v4 — Tracking client-side rico** (longo prazo): script próprio que escreve attribution chain ao note_attributes em cada compra. Mais flexível mas requer instalação em cada empresa.
5. **v5 — Custom touchpoints** (longo prazo): WhatsApp entry, quiz, lead form, affiliate. Cada um é mini-projeto.

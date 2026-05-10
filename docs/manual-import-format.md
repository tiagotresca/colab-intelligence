# Manual import — formato CSV

## Quando usar

Manual import é o caminho rápido para popular o `colab-intelligence` com:

1. **Histórico completo de Shopify** (passar dos limites de 60d/read_orders sem aprovação)
2. **Sites custom-made** que não têm API igual ao Shopify

Coexiste com o cron API daily — manual import tipicamente é one-off (todo o histórico) ou periódico (mensal). API daily continua a fazer incrementais.

## Como aceder

Dashboard de colab-intelligence → seleccionar empresa → **Manual import** section → 2 botões:

- **⬆ Shopify export (CSV)** — usa formato `shopify_csv`. Aceita o ficheiro CSV directo do Shopify Admin → Orders → Export.
- **⬆ Custom site CSV** — pede `source_platform` (ex: `aquinta_custom`) e usa formato `standard_v1` (definido abaixo).

Após upload bem-sucedido, customers são re-sintetizados automaticamente.

## Formato `shopify_csv` (export nativo)

No Shopify Admin: **Orders → Export → "Export all orders" → CSV**.

Aceitamos directamente. As colunas que extraímos:

| Shopify column | Mapeado para |
|---|---|
| `Id` (preferred) ou `Name` | `external_order_id` |
| `Email` | `email` |
| `Created at` | `created_at` |
| `Total` / `Subtotal` / `Discount Amount` / `Taxes` / `Shipping` | totals correspondentes |
| `Currency` | `currency` |
| `Financial Status` / `Fulfillment Status` | status |
| `Discount Code` | `primary_discount_code`, `has_discount=true` |
| `Landing site` / `Referring site` (se exportadas) | `landing_url`, `referrer` (UTMs parseadas de landing_url) |
| `Browser User Agent` (se exportada) | `device` (mobile/tablet/desktop derivado) |

**Notas:**
- O CSV nativo do Shopify tem uma row por **line item**, não por order. Agrupamos por `Id` e mantemos só o primeiro.
- Colunas que não conhecemos vão para `extra` jsonb (preservadas para uso futuro).
- Se o source_platform for `shopify_export`, os customers são sintetizados em `platform='shopify'` e fundidos com a API ETL daily — API ganha em conflicts.

## Formato `standard_v1` (sites custom)

Para sites custom-made, exportar CSV com estas colunas (UTF-8):

### Obrigatórias

- `external_order_id` — ID único do order na fonte (string)
- `created_at` — ISO 8601 (`2025-08-15T14:32:11Z`) ou `YYYY-MM-DD HH:MM:SS`

### Recomendadas

- `email` — sem isto não conseguimos juntar orders por customer
- `total_price` — número (com ponto decimal, ex: `42.50`)

### Opcionais

| Coluna | Descrição |
|---|---|
| `subtotal_price` | Pre tax/shipping |
| `total_discounts` | Soma de descontos aplicados |
| `total_tax` | IVA / sales tax |
| `total_shipping` | Custo de envio |
| `currency` | ISO 4217 (`EUR`, `USD`) |
| `financial_status` | `paid` / `refunded` / `pending` / `partially_refunded` |
| `fulfillment_status` | `fulfilled` / `partial` / `unfulfilled` |
| `external_customer_id` ou `customer_id` | ID do customer na fonte |
| `discount_code` | Código de desconto aplicado (se houver) |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | UTMs do tracking |
| `landing_url` | URL completa onde aterrou (UTMs também são parseadas daqui se utm_* estiverem em falta) |
| `referrer` | URL externa de origem |
| `device` | `mobile` / `tablet` / `desktop` |

### Exemplo

```csv
external_order_id,created_at,email,total_price,currency,financial_status,utm_source,utm_medium,utm_campaign,landing_url,device
ord_001,2025-08-15 14:32:11,joao@example.com,42.50,EUR,paid,instagram,social,verao_2025,https://aquinta.com/?utm_source=instagram&utm_medium=social,mobile
ord_002,2025-08-15 16:01:22,maria@example.com,89.00,EUR,paid,google,cpc,catalogo,https://aquinta.com/produto/x?utm_source=google&utm_medium=cpc,desktop
ord_003,2025-08-16 09:14:55,joao@example.com,28.00,EUR,paid,direct,,,,desktop
```

Customers são sintetizados em `platform=<source_platform>` (ex: `aquinta_custom`).

## Limites técnicos

- **Body size**: ~4MB JSON por upload (limite Vercel Functions). Para CSVs maiores, dividir em partes ou contactar para implementar Vercel Blob upload.
- **Encoding**: UTF-8.
- **Idempotência**: re-importar o mesmo CSV não duplica (primary key composite). Re-imports actualizam rows existentes.

## Conflict resolution com cron API

Para `source_platform='shopify_export'`:
- Quando `external_order_id` aparece em `shopify_orders_raw` (API) E em `manual_orders_raw` (CSV) → **API ganha** (mais fresca, com refunds/edits posteriores).
- Manual orders cobrem o que API não tem (orders fora dos 60d, history completo).

Para outros `source_platform` (custom sites):
- Manual import é a única fonte. Sem conflict.

## Onde os dados acabam

```
manual_orders_raw                          (raw, 1:1 com CSV row deduplicado)
       ↓
synthesizeCustomersShopify (se shopify_export) OU
synthesizeCustomersFromManual (outras platforms)
       ↓
customers (canonical, lifetime aggregates)
```

Customers são depois consumidos por:
- `get_business_health` MCP tool (KPIs 30d)
- Customer Quality Engine (PR B — em construção)
- Dashboard do colab-intelligence
- Botão Diagnóstico no work.colab

---

# Formato `subscriptions_v1` — Subscriptions + Subjects combinados

Para empresas com **modelo de subscrição** (Quinta, Luky Dog, etc) onde
cada subscrição é para **um sujeito** (cão, criança, planta, etc).

Cada row do CSV representa **UMA subscription** + os dados do subject que
ela serve. Repete-se o subject quando há múltiplas subscriptions para o
mesmo subject (raro). Subjects únicos são deduplicated por `external_subject_id`.

## Como usar

Dashboard → seleccionar empresa → Manual import → **⬆ Subscriptions+subjects** →
escolhe `source_platform` (ex: `aquinta_custom`) → upload do CSV.

## Schema das colunas

### Subscription (obrigatório se quiseres importar subscriptions)

| Coluna | Tipo | Descrição |
|---|---|---|
| `external_subscription_id` | string | ID único da subscription na fonte |
| `customer_email` | string | Email do dono da subscription (vai para email_hash) |
| `started_at` | ISO date | Quando a subscription começou |
| `status` | string | `active` / `paused` / `cancelled` (default: `active`) |
| `product_sku` | string | SKU do produto/plano |
| `frequency_days` | int | Frequência em dias (30 = mensal, 7 = semanal) |
| `mrr` | number | Monthly recurring revenue (calculado se quiseres) |
| `cancelled_at` | ISO date | Quando foi cancelada (se status=cancelled) |
| `cancelled_reason` | string | `too_expensive` / `pet_died` / `other` / etc |
| `subscription_metadata_json` | JSON | Campos extra estruturados |

### Subject (opcional — se a subscription tem um sujeito associado)

| Coluna | Tipo | Descrição |
|---|---|---|
| `external_subject_id` | string | ID único do subject na fonte (ex: 'dog_001') |
| `subject_type` | string | `dog` / `cat` / `child` / `plant` / etc |
| `subject_name` | string | Nome (ex: 'Bobby') |
| `subject_active` | bool | true/false (default: true) |
| `subject_<atributo>` | qualquer | Atributos típicos: `subject_breed`, `subject_age_years`, `subject_size`, `subject_weight_kg` — extraídos para `attributes` jsonb |
| `subject_attributes_json` | JSON | Alternativa: tudo num só JSON em vez de colunas individuais |

### Exemplo (Quinta — cães)

```csv
external_subscription_id,customer_email,started_at,status,product_sku,frequency_days,mrr,cancelled_at,cancelled_reason,external_subject_id,subject_type,subject_name,subject_breed,subject_age_years,subject_size,subject_weight_kg
sub_001,joao@example.com,2024-08-15,active,FOOD-MEDIUM,30,29.90,,,dog_001,dog,Bobby,poodle,3,medium,15
sub_002,maria@example.com,2024-05-10,cancelled,FOOD-SMALL,30,24.90,2025-12-15,too_expensive,dog_002,dog,Luna,bichon,5,small,8
sub_003,maria@example.com,2025-01-20,active,FOOD-MEDIUM,30,29.90,,,dog_003,dog,Rex,labrador,2,medium,28
```

Maria tem 2 cães (Luna e Rex), 2 subscriptions (uma cancelada, uma activa).
Cada cão é uma row em `subjects`. Cada subscription é uma row em `subscriptions`.
Customer Maria é uma row em `customers` (já existente do orders import).

### Exemplo alternativo com attributes_json

Se preferires JSON livre em vez de colunas individuais:

```csv
external_subscription_id,customer_email,started_at,status,product_sku,frequency_days,mrr,external_subject_id,subject_type,subject_name,subject_attributes_json
sub_001,joao@example.com,2024-08-15,active,FOOD-MEDIUM,30,29.90,dog_001,dog,Bobby,"{""breed"":""poodle"",""age_years"":3,""size"":""medium"",""weight_kg"":15,""dietary_restrictions"":""grain-free""}"
```

Útil quando o subject tem atributos não-standard (ex: `dietary_restrictions`).

## Onde os dados acabam

```
manual import (1 CSV)
       ↓
   subjects table        ←──── subject info
   subscriptions table   ←──── subscription info, com FK para subjects.id
       ↓
synthesizeSubscriptionMetrics (PR D.4 — em construção)
       ↓
KPIs: MRR, churn rate, retention by breed, LTV by subscription cohort
```

## Idempotência

- **Subjects** dedup por `(empresa_id, external_subject_id)` → upsert.
- **Subscriptions** dedup por `(empresa_id, external_subscription_id)` → upsert.
- Re-importar o mesmo CSV é seguro. Atualiza rows existentes.
- Se mudaste `cancelled_reason` no source e re-importas, o valor actualiza.

## Como ligar orders a subscriptions

Para análises tipo "campaign X traz subscriptions com churn baixo":
- Cada order do customer + subscription deve ter ligação em
  `order_subscription_links` table.
- Atualmente: extracção desta link **é feita pela synthesize layer**
  (PR D.4) — não é importada via CSV separado.

Se a tua `manual_orders_raw` tiver coluna `external_subscription_id` no
extra jsonb, o synth liga automaticamente. Para já, podes adicionar
essa coluna ao orders.csv:

```csv
external_order_id,created_at,email,total_price,...,external_subscription_id,delivery_number
order_001,2024-08-15,joao@example.com,29.90,...,sub_001,1
order_002,2024-09-15,joao@example.com,29.90,...,sub_001,2
```

(O importer de orders mete `external_subscription_id` em `extra` jsonb.
PR D.4 vai extrair daí.)

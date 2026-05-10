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

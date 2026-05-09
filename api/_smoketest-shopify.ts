// Smoke test temporário para validar plumbing do PR 1.
// Apaga-se no PR 2 quando `api/ingest/shopify.ts` for o real.
//
// Uso:
//   curl 'https://colab-intelligence-staging.vercel.app/api/_smoketest-shopify?empresa=<uuid>'
//
// Verifica:
//  1. workcolabSupabase consegue ler marketing_sources (cross-DB)
//  2. getShopifyCredentials devolve domain+token para a empresa
//  3. shopifyFetch alcança a Shopify (chama /shop.json — 1 req, leve)
//  4. listEmpresasWithShopify devolve a lista total

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getShopifyCredentials,
  listEmpresasWithShopify,
  shopifyFetch,
} from '../lib/shopify.js';

interface ShopResponse {
  shop?: {
    id?: number;
    name?: string;
    domain?: string;
    email?: string;
    plan_name?: string;
    currency?: string;
    timezone?: string;
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const empresa_id = (req.query.empresa as string | undefined)?.trim();
  if (!empresa_id) {
    res.status(400).json({
      error: 'Falta query param ?empresa=<uuid>',
    });
    return;
  }

  try {
    const empresas = await listEmpresasWithShopify();

    const creds = await getShopifyCredentials(empresa_id);
    const { body } = await shopifyFetch<ShopResponse>(creds, 'shop.json');
    const shop = body.shop ?? {};

    res.status(200).json({
      ok: true,
      empresa_id,
      shop: {
        id: shop.id,
        name: shop.name,
        domain: shop.domain,
        plan: shop.plan_name,
        currency: shop.currency,
        timezone: shop.timezone,
      },
      empresas_with_shopify: empresas.map((e) => ({
        empresa_id: e.empresa_id,
        empresa_name: e.empresa_name,
        domain: e.domain,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido';
    res.status(500).json({ ok: false, error: message });
  }
}

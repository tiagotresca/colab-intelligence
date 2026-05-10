// Limit-hit alarm para queries de synthesize/audit.
//
// Sítios em lib/synthesize/* e lib/audit/* têm `.limit(50000)` ou similar
// como cinto-de-segurança contra runaway queries. Em volumes reais das
// portfolio companies isto nunca dispara, mas se algum dia disparar
// silenciosamente produzimos KPIs falsos (truncados pela linha N).
//
// Esta função aborta a query loud em vez de continuar a mentir. Quando
// disparar, a fix é paginação ou rollup SQL — sinal claro de que é hora
// de evoluir o synthesize para essa empresa/canal.

export function assertNoLimitHit(
  rows: { length: number } | null | undefined,
  limit: number,
  context: string,
): void {
  if (!rows) return;
  if (rows.length >= limit) {
    throw new Error(
      `Row limit (${limit}) atingido em ${context}. ` +
        `Synthesize abortada para evitar KPIs truncados. ` +
        `Acção: paginar a query ou agregar via SQL antes de fetch.`,
    );
  }
}

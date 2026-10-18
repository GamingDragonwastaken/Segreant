/** One synchronous read model for CLI and dashboard; guesses never replace guesses. */
import type { Store, RepriceUpdate } from '../store/db.ts';
import { computeCost, withPricingSnapshot, type Provider } from './pricing.ts';
import { requestEconomicEventId } from '../economics/request.ts';

export interface RepriceModel {
  provider: string;
  model: string;
  rows: number;
  beforeUsd: number;
  afterUsd: number;
  afterBasis: 'list price' | 'your price';
}

/**
 * What priced the replacement amounts, from every row that will change: a
 * report built from the first row alone claimed "local rate card only" for a
 * batch that also held prices the user typed (PR #146 review).
 */
function repriceEvidence(updates: readonly RepriceUpdate[]) {
  if (updates.length === 0) return null;
  const sources = new Map<string, { costBasis: string; rateCardSha256: string | null; rateCardSourceKind: string; rows: number }>();
  for (const u of updates) {
    const key = JSON.stringify([u.pricing.costBasis, u.pricing.rateCardSha256, u.pricing.rateCardSourceKind]);
    const s = sources.get(key) ?? { costBasis: u.pricing.costBasis, rateCardSha256: u.pricing.rateCardSha256, rateCardSourceKind: u.pricing.rateCardSourceKind, rows: 0 };
    s.rows += 1;
    sources.set(key, s);
  }
  const list = [...sources.values()].sort((a, b) => b.rows - a.rows);
  const declaredRows = list.filter((s) => s.costBasis === 'user_declared_price').reduce((n, s) => n + s.rows, 0);
  const cards = [...new Set(list.filter((s) => s.rateCardSha256 !== null).map((s) => `${s.rateCardSourceKind} ${s.rateCardSha256}`))];
  const onlyCard = declaredRows === 0 && cards.length === 1 ? list.find((s) => s.rateCardSha256 !== null)! : null;
  return {
    localRateCardOnly: declaredRows === 0,
    cardSha256: onlyCard?.rateCardSha256 ?? null,
    sourceKind: onlyCard?.rateCardSourceKind ?? (declaredRows === updates.length ? 'none' : 'mixed'),
    declaredRows,
    sources: list,
    note: declaredRows === 0
      ? 'Local list-price estimate only; never provider invoice, discount, tax, credit, or reconciliation.'
      : `${declaredRows} of ${updates.length} rows take a price you set (your price, not a list price); the rest are local list prices. None is a provider invoice, discount, tax, credit, or reconciliation.`,
  };
}

export function previewReprice(store: Store) {
  // Every row of one plan is priced from the same declarations.
  return withPricingSnapshot(() => planReprice(store));
}

function planReprice(store: Store) {
  const rows = store.estimatedRequestRows();
  const updates: RepriceUpdate[] = [];
  const meta = new Map<string, PlannedRow>();
  let stillEstimated = 0;
  // Rows with cache writes whose duration was never recorded (before Segreant
  // kept it): priced at the 5-minute rate, as they were first priced, and
  // counted so the preview says so (PR #146 review).
  let cacheDurationUnknown = 0;
  for (const r of rows) {
    const c = computeCost(r.provider as Provider, r.model, {
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
      ...(r.cacheWriteTtl === null ? {} : { cacheWriteTtl: r.cacheWriteTtl }),
    });
    if (c.estimated) { stillEstimated++; continue; }
    // A row with an exact economic event can only be corrected by an exact
    // amount. A custom card may omit the decimal companions, and the plan used
    // to promise such a row, then --apply refused it and rolled back the whole
    // batch (PR #146 review). It stays an estimate until a card can price it exactly.
    if (c.exact === undefined && store.economic().read(requestEconomicEventId(r.requestId)) !== null) { stillEstimated++; continue; }
    // Counted only for rows the plan will rewrite, so the preview never says a
    // row's writes are priced at the 5-minute rate when it is left untouched.
    if (r.cacheWriteTokens > 0 && r.cacheWriteTtl === null) cacheDurationUnknown++;
    updates.push({ requestId: r.requestId, costUsd: c.costUsd, pricing: c.pricing, ...(c.exact === undefined ? {} : { economicAmount: c.exact.total }) });
    meta.set(r.requestId, {
      provider: r.provider, model: r.model, beforeUsd: r.costUsd,
      cacheDurationUnknown: r.cacheWriteTokens > 0 && r.cacheWriteTtl === null,
    });
  }
  return { ...summarize(updates, meta, 0), estimatedRows: rows.length, stillEstimated, cacheDurationUnknown, meta };
}

interface PlannedRow { provider: string; model: string; beforeUsd: number; cacheDurationUnknown: boolean }

/** Totals, models and evidence for exactly these updates: the plan, or the rows a write touched. */
function summarize(updates: RepriceUpdate[], meta: ReadonlyMap<string, PlannedRow>, alreadyRepriced: number) {
  const byModel = new Map<string, RepriceModel>();
  for (const u of updates) {
    const r = meta.get(u.requestId)!;
    const key = JSON.stringify([r.provider, r.model]);
    const agg = byModel.get(key) ?? {
      provider: r.provider, model: r.model, rows: 0, beforeUsd: 0, afterUsd: 0,
      afterBasis: u.pricing.rateMatchKind === 'user_declared' || u.pricing.rateMatchKind === 'user_declared_free' ? 'your price' : 'list price',
    };
    agg.rows++;
    agg.beforeUsd += r.beforeUsd;
    agg.afterUsd += u.costUsd;
    byModel.set(key, agg);
  }
  return {
    applied: false, repriceable: updates.length,
    /** Planned rows another reprice had already rewritten by the time this one wrote: left alone, not counted. */
    alreadyRepriced,
    totalBeforeUsd: [...byModel.values()].reduce((a, v) => a + v.beforeUsd, 0),
    totalAfterUsd: [...byModel.values()].reduce((a, v) => a + v.afterUsd, 0),
    priceEvidence: repriceEvidence(updates),
    byModel: [...byModel.values()],
    // Internal write plan; never expose the exact bigint money objects on the JSON wire.
    updates,
    realizationSync: null as ReturnType<Store['applyRepricedCosts']> | null,
  };
}

/**
 * Compute once, write that plan through the Store's audited transaction, and
 * report only the rows the transaction wrote. Another process may reprice the
 * same rows between the plan and the write; the store skips a row that is no
 * longer an estimate, and the result used to claim it anyway (PR #146 review).
 */
export function applyReprice(store: Store) {
  const preview = previewReprice(store);
  if (preview.updates.length === 0) return { ...preview, applied: true };
  const { writtenRequestIds, ...realizationSync } = store.applyRepricedCosts(preview.updates);
  const written = new Set(writtenRequestIds);
  const done = preview.updates.filter((u) => written.has(u.requestId));
  const cacheDurationUnknown = done.filter((u) => preview.meta.get(u.requestId)!.cacheDurationUnknown).length;
  return {
    ...preview,
    ...summarize(done, preview.meta, preview.updates.length - done.length),
    cacheDurationUnknown,
    applied: true,
    realizationSync,
  };
}

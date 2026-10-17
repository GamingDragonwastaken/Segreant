/** One synchronous read model for CLI and dashboard; guesses never replace guesses. */
import type { Store, RepriceUpdate } from '../store/db.ts';
import { computeCost, type Provider } from './pricing.ts';

export interface RepriceModel {
  provider: string;
  model: string;
  rows: number;
  beforeUsd: number;
  afterUsd: number;
  afterBasis: 'list price' | 'your price';
}

export function previewReprice(store: Store) {
  const rows = store.estimatedRequestRows();
  const updates: RepriceUpdate[] = [];
  const byModel = new Map<string, RepriceModel>();
  let stillEstimated = 0;
  for (const r of rows) {
    const c = computeCost(r.provider as Provider, r.model, {
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
    });
    if (c.estimated) { stillEstimated++; continue; }
    updates.push({ requestId: r.requestId, costUsd: c.costUsd, pricing: c.pricing, ...(c.exact === undefined ? {} : { economicAmount: c.exact.total }) });
    const key = JSON.stringify([r.provider, r.model]);
    const agg = byModel.get(key) ?? {
      provider: r.provider, model: r.model, rows: 0, beforeUsd: 0, afterUsd: 0,
      afterBasis: c.pricing.rateMatchKind === 'user_declared' ? 'your price' : 'list price',
    };
    agg.rows++;
    agg.beforeUsd += r.costUsd;
    agg.afterUsd += c.costUsd;
    byModel.set(key, agg);
  }
  return {
    applied: false, estimatedRows: rows.length, repriceable: updates.length, stillEstimated,
    totalBeforeUsd: [...byModel.values()].reduce((a, v) => a + v.beforeUsd, 0),
    totalAfterUsd: [...byModel.values()].reduce((a, v) => a + v.afterUsd, 0),
    priceEvidence: updates.length ? {
      localRateCardOnly: true,
      cardSha256: updates[0]!.pricing.rateCardSha256,
      sourceKind: updates[0]!.pricing.rateCardSourceKind,
      note: 'Local list-price estimate only; never provider invoice, discount, tax, credit, or reconciliation.',
    } : null,
    byModel: [...byModel.values()],
    // Internal write plan; never expose the exact bigint money objects on the JSON wire.
    updates,
    realizationSync: null as ReturnType<Store['applyRepricedCosts']> | null,
  };
}

/** Compute once, write exactly that plan through the Store's audited transaction. */
export function applyReprice(store: Store): ReturnType<typeof previewReprice> {
  const preview = previewReprice(store);
  const realizationSync = preview.updates.length ? store.applyRepricedCosts(preview.updates) : null;
  return { ...preview, applied: true, realizationSync };
}

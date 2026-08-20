/**
 * Pricing provenance — the one read model, for every surface.
 *
 * `fiscus pricing --coverage` and `GET /api/pricing` answer the same question:
 * for a window of the ledger, how was each recorded amount actually priced?
 * Grouped by the evidence captured AT METERING TIME — cost basis, rate-match
 * kind, card source, card digest — so two different pricing eras never merge
 * into one row.
 *
 * It lives here rather than in either caller because the CLI and the dashboard
 * previously would have computed it independently, and this repository has
 * already paid for that mistake once: `src/value/report.ts` exists because five
 * comments in the dashboard asserted by hand that its value arithmetic matched
 * the CLI's. A hand-maintained invariant across two files is not an invariant.
 * One function means the two surfaces cannot disagree about provenance.
 *
 * THE BOUNDARY THIS MUST NOT CROSS. Every figure here is LOCAL LIST-PRICE
 * evidence. This module reads; it never fetches a rate card, never reprices a
 * historical row, and never presents an amount as provider-billed or
 * reconciled. `boundary` ships with the payload so the claim travels with the
 * number rather than living in whichever surface happens to render it.
 *
 * `import type { Store }` is deliberate: `src/store/db.ts` imports values from
 * `./pricing.ts` beside this file, so a value import here would close a cycle.
 * The type is erased.
 */

import type { Store } from '../store/db.ts';
import type { PricingEvidenceBucket } from '../store/db.ts';
import { pricingStatus, type PricingStatus } from './pricing.ts';

/** The sentence that travels with every coverage payload. Exported so a caller cannot paraphrase it. */
export const PRICING_COVERAGE_BOUNDARY =
  'Captured local pricing evidence only. It does not fetch pricing, reprice history, or represent any amount as provider-billed or reconciled cost.';

export interface PricingCoverageWindow {
  startMs: number;
  endMs: number;
  /** Human label for the window — 'all recorded time' or 'last N days'. */
  label: string;
}

export interface PricingCoveragePayload {
  window: PricingCoverageWindow;
  activeRateCard: PricingStatus;
  total: { costUsd: number; requests: number };
  /** One row per distinct pricing-evidence cohort in the window. */
  provenance: PricingEvidenceBucket[];
  boundary: typeof PRICING_COVERAGE_BOUNDARY;
}

export interface PricingCoverageOptions {
  /** All recorded time. Takes precedence over `days`, matching the CLI's --all. */
  all: boolean;
  /** Window length in days when `all` is false. Must be finite and > 0. */
  days: number;
  /** Rate-card staleness threshold, from config.pricing.maxAgeDays. */
  maxAgeDays: number;
}

/** Resolve the window exactly as `--all` / `--days N` do, so both surfaces label it identically. */
export function pricingCoverageWindow(opts: PricingCoverageOptions, now: number): PricingCoverageWindow {
  const day = 24 * 60 * 60 * 1000;
  return {
    startMs: opts.all ? 0 : now - opts.days * day,
    endMs: now + 1000,
    label: opts.all ? 'all recorded time' : `last ${opts.days} day${opts.days === 1 ? '' : 's'}`,
  };
}

/**
 * The read model. Two store reads and a rate-card status — no writes, and
 * nothing that could change how a historical row was priced.
 */
export function pricingCoverage(
  store: Store,
  opts: PricingCoverageOptions,
  now = Date.now(),
): PricingCoveragePayload {
  const window = pricingCoverageWindow(opts, now);
  const total = store.summary(window.startMs, window.endMs);
  return {
    window,
    activeRateCard: pricingStatus(opts.maxAgeDays),
    total: { costUsd: total.costUsd, requests: total.requests },
    provenance: store.pricingEvidenceByModel(window.startMs, window.endMs),
    boundary: PRICING_COVERAGE_BOUNDARY,
  };
}

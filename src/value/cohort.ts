/**
 * Per-user value — "how much of the AI spend each person turns into real
 * outcomes" — computed under a hard anti-surveillance guardrail.
 *
 * The metric is EXTRACTION: the shrinkage-adjusted share of a user's AI spend
 * that reached a realized outcome (∈ [0,1]). It answers "am I getting value out
 * of this tool?" per person — the thing a developer actually wants to know about
 * themselves, and the thing an org needs in aggregate to know its spend is
 * working. It is NOT a productivity leaderboard, and the code refuses to become
 * one:
 *
 *   1. OPT-IN.        Per-user value is off unless explicitly enabled. Spend-by-
 *                     user (cost governance) is separate; VALUE-by-user is the
 *                     sensitive axis, so it defaults dark.
 *   2. k-ANONYMITY.   Below `minCohort` identified users, ALL per-user math is
 *                     suppressed — a small team can't use this to finger one dev.
 *   3. DISTRIBUTION,  The org-facing report carries only the distribution
 *      NOT NAMES.     (median, spread) and a coaching lever — never a ranked list
 *                     of who's "best"/"worst". Names surface only in a person's
 *                     own `selfView`, about themselves.
 *   4. HELP, NOT      The headline lever is COACHING HEADROOM: the latent value
 *      RANK.          unlocked if sub-median extractors were enabled up to the
 *                     median — an argument for support/training, not for blame.
 *
 * Thin samples are shrunk toward the cohort mean (empirical-Bayes, see
 * reliability.ts) so nobody is judged on two noisy sessions.
 */

import type { Store } from '../store/db.ts';
import { classifySession } from './usage.ts';
import { estimateBetaPrior, localDataWeight, type Observation } from './reliability.ts';
import { economicAttributionFromAttributions, type EconomicAttribution } from '../economics/attribution.ts';
import type { UsageEconomicRollup } from './usage.ts';

/** Raw per-user inputs. `realizedValueUsd ≤ costUsd`, so extraction ∈ [0,1]. */
export interface UserValueRow {
  user: string;
  sessions: number;
  realizedSessions: number;
  costUsd: number;
  realizedValueUsd: number;
  /** Exact effective spend across this user's sessions; numeric fields remain compatibility-only. */
  economic?: EconomicAttribution;
  /** Exact effective spend on the subset of sessions with a confirmed outcome. */
  realizedEconomic?: EconomicAttribution;
}

export interface CohortOptions {
  enabled: boolean;
  minCohort?: number; // k-anonymity floor; default 5
  broadThreshold?: number; // dispersion below this reads as broad-based; default 0.6
}

export interface CohortDistribution {
  cohortSize: number;
  medianExtraction: number;
  p25Extraction: number;
  p75Extraction: number;
  /** Robust spread (p75−p25)/median. 0 = everyone extracts alike. */
  dispersion: number;
  /** Value is broad-based (not concentrated in a few) — an org-health signal. */
  broadBased: boolean;
  /** Latent value if sub-median extractors were enabled up to the median, at their own spend. */
  coachingHeadroomUsd: number;
  totalCostUsd: number;
  totalRealizedValueUsd: number;
  /** Exact effective spend coverage for the same identified-user distribution. */
  economic?: UsageEconomicRollup;
}

export interface CohortReport {
  enabled: boolean;
  suppressed: boolean;
  reason: string;
  distribution: CohortDistribution | null;
}

export interface SelfView {
  user: string;
  sessions: number;
  extraction: number; // your shrinkage-adjusted realized share
  /**
   * 0..1 mixing weight on your OWN sessions vs the cohort prior — not a
   * confidence level and not a probability that the figure is right.
   */
  localDataWeight: number;
  cohortComparable: boolean; // enough peers to compare without identifying them
  percentile: number | null; // your standing within the cohort (null if not comparable)
  vsMedianPct: number | null; // +/- % vs the cohort median (null if not comparable)
}

const DEFAULT_MIN_COHORT = 5;
const DEFAULT_BROAD_THRESHOLD = 0.6;

/** Linear-interpolated percentile over an ascending array. */
function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

/** Identified users only — 'unassigned' is untagged traffic, not a person. */
function identified(rows: UserValueRow[]): UserValueRow[] {
  return rows.filter((r) => r.user !== 'unassigned' && r.sessions > 0);
}

/**
 * Shrunken extraction per user: the share of realized value, pulled toward the
 * cohort mean by how many sessions back it. The prior is estimated from the
 * cohort's own dispersion (extra-binomial), so a coherent team barely shrinks
 * and a noisy one shrinks hard. Shrinkage assumes the cohort is exchangeable;
 * where people do materially different work, the pooled mean is the wrong
 * target (see reliability.ts).
 */
function shrunkExtraction(rows: UserValueRow[]): Map<string, { extraction: number; localDataWeight: number }> {
  const obs: Observation[] = rows.map((r) => ({ k: r.realizedSessions, n: r.sessions }));
  const prior = estimateBetaPrior(obs, {});
  const out = new Map<string, { extraction: number; localDataWeight: number }>();
  for (const r of rows) {
    // Shrink the realized SHARE toward the mean using session counts as evidence,
    // then anchor it in dollars: extraction is value-weighted, its trust is count-weighted.
    const rawShare = r.costUsd > 0 ? r.realizedValueUsd / r.costUsd : 0;
    const own = localDataWeight(r.sessions, prior);
    const shrunkShare = own * rawShare + (1 - own) * prior.mean;
    out.set(r.user, { extraction: clamp01(shrunkShare), localDataWeight: own });
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Pure distribution + coaching lever over identified users. Assumes cohort ≥ k already checked. */
export function computeCohortDistribution(rows: UserValueRow[], broadThreshold = DEFAULT_BROAD_THRESHOLD): CohortDistribution {
  const ppl = identified(rows);
  const ext = shrunkExtraction(ppl);
  const values = ppl.map((r) => ext.get(r.user)!.extraction).sort((a, b) => a - b);
  const median = quantile(values, 0.5);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  const dispersion = median > 0 ? (p75 - p25) / median : 0;

  // Coaching headroom: for everyone below the median, how many of their own
  // dollars would have realized had they extracted at the median rate. Summed,
  // this is the enablement upside — a reason to train, not to rank.
  let headroom = 0;
  for (const r of ppl) {
    const e = ext.get(r.user)!.extraction;
    if (e < median) headroom += r.costUsd * (median - e);
  }

  const exactValues = ppl.flatMap((row) => row.economic === undefined ? [] : [row.economic]);
  const realizedExactValues = ppl.flatMap((row) => row.realizedEconomic === undefined ? [] : [row.realizedEconomic]);
  const economic: UsageEconomicRollup = {
    coverage: exactValues.length === 0
      ? 'legacy_unknown'
      : exactValues.length === ppl.length && economicAttributionFromAttributions(exactValues).complete
        ? 'exact'
        : 'partial',
    total: exactValues.length === 0 ? null : economicAttributionFromAttributions(exactValues),
    realized: exactValues.length === 0 ? null : economicAttributionFromAttributions(realizedExactValues),
  };

  return {
    cohortSize: ppl.length,
    medianExtraction: median,
    p25Extraction: p25,
    p75Extraction: p75,
    dispersion,
    broadBased: dispersion <= broadThreshold,
    coachingHeadroomUsd: headroom,
    totalCostUsd: ppl.reduce((s, r) => s + r.costUsd, 0),
    totalRealizedValueUsd: ppl.reduce((s, r) => s + r.realizedValueUsd, 0),
    economic,
  };
}

/** The org-facing report — gated by opt-in and k-anonymity. */
export function cohortReport(rows: UserValueRow[], opts: CohortOptions): CohortReport {
  const k = opts.minCohort ?? DEFAULT_MIN_COHORT;
  if (!opts.enabled) {
    return { enabled: false, suppressed: true, reason: 'per-user value is opt-in and disabled', distribution: null };
  }
  const ppl = identified(rows);
  if (ppl.length < k) {
    return {
      enabled: true,
      suppressed: true,
      reason: `cohort of ${ppl.length} is below the k-anonymity floor of ${k}; per-user value withheld`,
      distribution: null,
    };
  }
  return {
    enabled: true,
    suppressed: false,
    reason: `distribution over ${ppl.length} users; individuals not identified`,
    distribution: computeCohortDistribution(ppl, opts.broadThreshold),
  };
}

/**
 * A single person's view OF THEMSELVES. Their own extraction and local-data
 * weight are always returned (it's their data). The comparison to peers (percentile, gap to
 * median) is gated by cohort size, so seeing where you stand can never reveal an
 * individual peer.
 */
export function selfView(rows: UserValueRow[], user: string, opts: CohortOptions): SelfView | null {
  const ppl = identified(rows);
  const mine = ppl.find((r) => r.user === user);
  if (!mine) return null;
  const ext = shrunkExtraction(ppl);
  const me = ext.get(user)!;
  const k = opts.minCohort ?? DEFAULT_MIN_COHORT;
  const comparable = opts.enabled && ppl.length >= k;

  let percentile: number | null = null;
  let vsMedianPct: number | null = null;
  if (comparable) {
    const values = ppl.map((r) => ext.get(r.user)!.extraction).sort((a, b) => a - b);
    const below = values.filter((v) => v < me.extraction).length;
    percentile = ppl.length > 1 ? below / (ppl.length - 1) : 0;
    const median = quantile(values, 0.5);
    vsMedianPct = median > 0 ? (me.extraction - median) / median : 0;
  }
  return {
    user,
    sessions: mine.sessions,
    extraction: me.extraction,
    localDataWeight: me.localDataWeight,
    cohortComparable: comparable,
    percentile,
    vsMedianPct,
  };
}

/**
 * Build per-user rows from the store: non-coding session outcomes attributed by
 * the user tag (see Store.sessionUnitsByUser for why coding value is excluded —
 * it's git-attributed, not user-attributed, so mixing it in would mislead).
 */
export function userValueRows(store: Store, opts: { startMs: number; endMs: number }): UserValueRow[] {
  const sessions = store.economicSessionUnitsByUser(opts.startMs, opts.endMs);
  const agg = new Map<string, UserValueRow>();
  const exactByUser = new Map<string, EconomicAttribution[]>();
  const realizedExactByUser = new Map<string, EconomicAttribution[]>();
  for (const s of sessions) {
    const outcome = classifySession(store.signalsForCommit(s.sessionId));
    let row = agg.get(s.user);
    if (!row) {
      row = { user: s.user, sessions: 0, realizedSessions: 0, costUsd: 0, realizedValueUsd: 0 };
      agg.set(s.user, row);
    }
    row.sessions += 1;
    row.costUsd += s.costUsd;
    const exact = exactByUser.get(s.user) ?? [];
    exact.push(s.economic);
    exactByUser.set(s.user, exact);
    if (outcome.realized) {
      row.realizedSessions += 1;
      row.realizedValueUsd += s.costUsd; // realized value = the spend that turned into a kept outcome
      const realizedExact = realizedExactByUser.get(s.user) ?? [];
      realizedExact.push(s.economic);
      realizedExactByUser.set(s.user, realizedExact);
    }
  }
  for (const [user, row] of agg) {
    row.economic = economicAttributionFromAttributions(exactByUser.get(user) ?? []);
    row.realizedEconomic = economicAttributionFromAttributions(realizedExactByUser.get(user) ?? []);
  }
  return [...agg.values()];
}

/** Convenience: rows + report in one call. */
export function computeCohort(store: Store, opts: { startMs: number; endMs: number } & CohortOptions): CohortReport {
  return cohortReport(userValueRows(store, opts), opts);
}

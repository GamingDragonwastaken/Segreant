/**
 * Task-standardized comparison — the index-number layer that makes cross-entity
 * and over-time team numbers mean something.
 *
 * THE FLAW THIS FIXES (Simpson's paradox, the classic aggregation trap): a team
 * can "beat" another on raw pooled realization purely because it worked on an
 * easier task mix — better within EVERY stratum yet worse pooled, or vice
 * versa. Any auditable cross-team or over-time comparison must therefore fix a
 * task basket first and compare like with like. Two standard constructions,
 * both pure and dependency-free so the team server can import this file by
 * relative path exactly as it imports rollup.ts:
 *
 *   1. STANDARDIZED SCORE (direct standardization, the epidemiology workhorse):
 *      R_std = Σ_t ω_t · R_t over a FIXED reference basket ω. Entities are
 *      compared on the same basket, so task-mix differences cancel by
 *      construction. The reference weights must be chosen BEFORE looking at
 *      current outcomes (an ex-ante operator input, or a pooled prior-period
 *      mix) — weights picked after seeing the numbers are just another way to
 *      game the comparison, so `how` always names where the basket came from.
 *
 *   2. FISHER CHANGE INDEX (the index-number literature's base-symmetric
 *      over-time comparison): Laspeyres asks "at the OLD mix, how did
 *      performance move?", Paasche asks it at the NEW mix, and Fisher is their
 *      geometric mean — symmetric in the two periods, so neither period's mix
 *      gets to pick the answer.
 *
 * Honesty rules shared by both: strata missing on one side are EXCLUDED and
 * NAMED (never imputed, never scored as zero); coverage (the share of the
 * reference basket the entity actually has) travels with every number; too
 * little overlap → null, never an invented comparison.
 */

export interface StratumScore {
  stratum: string; // e.g. a task-type, or "project·taskType"
  value: number | null; // the entity's score in this stratum (null = not observed)
}

export interface StandardizedScore {
  /** Σ ω_t R_t over covered strata, renormalized to the covered weight. Null when nothing overlaps. */
  score: number | null;
  /** Share of the reference basket's weight the entity actually covers, 0..1. */
  coveredWeight: number;
  /** Reference strata the entity has no observation for (excluded + disclosed, never zero-filled). */
  missing: string[];
  /** Entity strata outside the reference basket (excluded + disclosed — they'd smuggle mix back in). */
  extra: string[];
  how: string;
}

/**
 * Directly standardize one entity's per-stratum scores onto a fixed reference
 * basket. Renormalizing over covered weight keeps a missing stratum from
 * reading as a zero — but that makes two entities comparable ONLY when their
 * coverage is similar, which is why `coveredWeight` is part of the result, not
 * a footnote.
 */
export function standardizedScore(scores: ReadonlyArray<StratumScore>, referenceWeights: Record<string, number>): StandardizedScore {
  const byStratum = new Map(scores.map((s) => [s.stratum, s.value] as const));
  const refEntries = Object.entries(referenceWeights).filter(([, w]) => w > 0);
  const refTotal = refEntries.reduce((s, [, w]) => s + w, 0);
  if (refEntries.length === 0 || refTotal <= 0) {
    return { score: null, coveredWeight: 0, missing: [], extra: [], how: 'empty reference basket — nothing to standardize onto' };
  }

  let weighted = 0;
  let covered = 0;
  const missing: string[] = [];
  for (const [stratum, w] of refEntries) {
    const v = byStratum.get(stratum);
    if (v === null || v === undefined) {
      missing.push(stratum);
      continue;
    }
    weighted += (w / refTotal) * v;
    covered += w / refTotal;
  }
  const extra = scores.filter((s) => s.value !== null && !(s.stratum in referenceWeights)).map((s) => s.stratum);

  if (covered <= 0) {
    return { score: null, coveredWeight: 0, missing, extra, how: 'no overlap with the reference basket — comparison refused, not invented' };
  }
  return {
    score: weighted / covered,
    coveredWeight: covered,
    missing,
    extra,
    how: `standardized over ${refEntries.length - missing.length}/${refEntries.length} reference strata (${Math.round(covered * 100)}% of basket weight)${missing.length ? `; missing: ${missing.join(', ')}` : ''}${extra.length ? `; outside basket (excluded): ${extra.join(', ')}` : ''}`,
  };
}

export interface StratumPeriod {
  stratum: string;
  /** This stratum's share of the period's activity (e.g. unit share). Need not be pre-normalized. */
  share: number;
  /** The period's score in this stratum (must be > 0 to enter a ratio index). */
  value: number;
}

export interface FisherChange {
  /** Change at the OLD period's mix: Σ s_t⁰ (R_t¹/R_t⁰). */
  laspeyres: number | null;
  /** Change at the NEW period's mix: (Σ s_t¹ (R_t⁰/R_t¹))⁻¹. */
  paasche: number | null;
  /** √(L·P) — base-symmetric; >1 = genuine improvement at matched task mix. */
  fisher: number | null;
  /** Strata present with positive value in BOTH periods (the comparison set). */
  commonStrata: number;
  /** Strata dropped for being one-sided or nonpositive — disclosed, never imputed. */
  dropped: string[];
  how: string;
}

/**
 * Base-symmetric over-time change at matched task mix. Only strata observed
 * with positive scores in BOTH periods enter (a ratio needs both ends); shares
 * are renormalized over that common set so the two period-mix weightings are
 * proper distributions.
 */
export function fisherChangeIndex(period0: ReadonlyArray<StratumPeriod>, period1: ReadonlyArray<StratumPeriod>): FisherChange {
  const p0 = new Map(period0.map((s) => [s.stratum, s] as const));
  const p1 = new Map(period1.map((s) => [s.stratum, s] as const));
  const common: string[] = [];
  const dropped: string[] = [];
  for (const stratum of new Set([...p0.keys(), ...p1.keys()])) {
    const a = p0.get(stratum);
    const b = p1.get(stratum);
    if (a && b && a.value > 0 && b.value > 0 && a.share >= 0 && b.share >= 0) common.push(stratum);
    else dropped.push(stratum);
  }
  if (common.length === 0) {
    return { laspeyres: null, paasche: null, fisher: null, commonStrata: 0, dropped, how: 'no stratum observed with positive scores in both periods — change is unidentified' };
  }

  const w0Total = common.reduce((s, t) => s + p0.get(t)!.share, 0);
  const w1Total = common.reduce((s, t) => s + p1.get(t)!.share, 0);
  if (w0Total <= 0 || w1Total <= 0) {
    return { laspeyres: null, paasche: null, fisher: null, commonStrata: common.length, dropped, how: 'common strata carry no activity share in one period — change is unidentified' };
  }

  let laspeyres = 0;
  let paascheInv = 0;
  for (const t of common) {
    const a = p0.get(t)!;
    const b = p1.get(t)!;
    laspeyres += (a.share / w0Total) * (b.value / a.value);
    paascheInv += (b.share / w1Total) * (a.value / b.value);
  }
  const paasche = 1 / paascheInv;
  const fisher = Math.sqrt(laspeyres * paasche);
  return {
    laspeyres,
    paasche,
    fisher,
    commonStrata: common.length,
    dropped,
    how: `Fisher change over ${common.length} common strata${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''} — symmetric in the two periods' task mixes`,
  };
}

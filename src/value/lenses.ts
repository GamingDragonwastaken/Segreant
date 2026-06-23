/**
 * Return on Intelligence — the four value lenses + the composite index.
 *
 * Each lens answers a different real question about "how much you got from the
 * AI" (docs/RETURN-ON-INTELLIGENCE.md §3). We never pick one numerator; we
 * report all four and compose them with a GEOMETRIC MEAN — so if any single lens
 * collapses toward 0, the whole index collapses. There is no one axis to game.
 *
 * A lens with no signal is `uninstrumented` (value null), excluded from the mean,
 * and reflected in coverage — the same honesty rule as the gates: unknown ≠ fault.
 *
 * This layer is modality-agnostic by design: it reads a small structural shape,
 * not git specifics, so non-coding usage can feed the same lenses later.
 */

import type { Gate, Verdict } from './gates.ts';

interface UnitLike {
  maturing: boolean;
  acceptance: number | null;
  linesAdded: number;
  funnel: { realized: boolean; results: Array<{ gate: Gate; verdict: Verdict }> };
}

export interface RealizationLike {
  firstPassAcceptance: number | null;
  units: UnitLike[];
  matured: {
    realizationRate: number;
    totalCostUsd: number;
    realizedValueUsd: number;
    netRealizedValueUsd?: number; // realized value net of rework; falls back to gross when absent
  };
}

export interface LensValue {
  value: number | null; // 0..1, or null when uninstrumented
  instrumented: boolean;
  how: string;
}

/** An RoI value as an interval. low ≤ point ≤ high; width = counterfactual uncertainty. */
export interface RoIInterval {
  low: number | null;
  point: number | null;
  high: number | null;
}

export interface RoIResult {
  lenses: {
    realization: LensValue;
    acceptance: LensValue;
    lift: LensValue;
    impact: LensValue;
  };
  coverage: number; // instrumented lenses / 4
  roiIndex: number | null; // 0..100, weighted geometric mean of instrumented lenses (the point)
  // The HONEST object: RoI is interval-valued because the counterfactual (Lift) is
  // only partially identified. The point above is the interval's interior estimate.
  // Width shrinks as you wire Lift with a behavioral A/B. (docs §5.)
  roiInterval: RoIInterval;
  // True when the Index is an UPPER bound on the real conversion — i.e. some
  // necessary lenses are un-instrumented, and unobserved conditions can only
  // lower it. More measurement makes the number more honest, never inflated.
  indexIsUpperBound: boolean;
  tokenCostUsd: number;
  effortTaxUsd: number;
  realizedEfficiency: number | null; // realized value / (token + effort) cost, 0..1
  notes: string[];
}

export interface RoIOptions {
  laborRatePerHour?: number | null; // unset → effort tax 0, denominator token-only
  minutesPerUnitRework?: number; // modeled minutes a fully-reworked unit costs a human
  lift?: number | null; // injected lift score (0..1) when measured; null otherwise
  liftRange?: { low: number | null; high: number | null }; // partial-ID bound for Lift, in lens-score units
  liftHow?: string; // how Lift was sourced (baseline estimate / measured A-B / synthetic) — honest disclosure
  weights?: { realization: number; acceptance: number; lift: number; impact: number };
  theta?: number; // CES substitution parameter; 0 (default) = the forced geometric mean
}

/** Impact weight for a unit: bigger and shipped-to-prod changes weigh more. */
function impactWeight(u: UnitLike): number {
  const blast = 1 + Math.log10(1 + Math.max(0, u.linesAdded)) / 2;
  const shipped = u.funnel.results.find((r) => r.gate === 'shipped')?.verdict === 'pass' ? 1.5 : 1;
  return blast * shipped;
}

/**
 * Default lens weights, calibrated from the productivity literature
 * (docs/RETURN-ON-INTELLIGENCE.md §research): value/quality signals dominate,
 * raw acceptance is moderate. Lift (the counterfactual) carries the most weight
 * because it is the closest thing to "was it worth it"; survival-anchored
 * Realization and Impact are high; Acceptance is a faster but shallower signal.
 */
export const DEFAULT_LENS_WEIGHTS = { realization: 1.0, acceptance: 0.7, lift: 1.2, impact: 1.0 } as const;

/**
 * Weighted power mean M_θ(x) = (Σ wₖ xₖ^θ / Σ wₖ)^{1/θ} — the CES family that
 * generalizes the aggregator (docs/RETURN-ON-INTELLIGENCE.md §3–4):
 *
 *   θ → 0   weighted GEOMETRIC mean (the default). The UNIQUE scale-invariant,
 *           multiplicative aggregator: M(x·y) = M(x)·M(y). Forced by requiring
 *           that quality composes the way value composes along the funnel.
 *   θ = 1   arithmetic mean (perfect substitutes — gameable; never the default).
 *   θ → −∞  minimum (Leontief, pure weakest-link).
 *
 * θ is the elasticity of substitution between lenses. For θ ≤ 0 any zero value
 * collapses the result — by design, no axis can be bought back.
 */
export function weightedPowerMean(pairs: Array<{ value: number; weight: number }>, theta = 0): number {
  if (pairs.length === 0) return 0;
  const wSum = pairs.reduce((s, p) => s + p.weight, 0);
  if (wSum <= 0) return 0;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (theta === 0) {
    if (pairs.some((p) => p.value <= 0)) return 0; // geometric collapse
    let wln = 0;
    for (const p of pairs) wln += p.weight * Math.log(clamp(p.value));
    return Math.exp(wln / wSum);
  }
  if (theta < 0 && pairs.some((p) => p.value <= 0)) return 0; // Leontief-side collapse
  let acc = 0;
  for (const p of pairs) acc += p.weight * Math.pow(clamp(p.value), theta);
  return Math.pow(acc / wSum, 1 / theta);
}

export function computeReturnOnIntelligence(report: RealizationLike, opts: RoIOptions = {}): RoIResult {
  const notes: string[] = [];
  const mature = report.units.filter((u) => !u.maturing);

  // --- Lens 1: Realization (did spend become something real & kept?) ---
  const realization: LensValue = {
    value: mature.length > 0 ? report.matured.realizationRate : null,
    instrumented: mature.length > 0,
    how: 'verified-outcome conversion (the Realization funnel)',
  };
  if (!realization.instrumented) notes.push('Realization uninstrumented: no matured units yet.');

  // --- Lens 2: Acceptance (did you keep it first try?) ---
  const acceptance: LensValue = {
    value: report.firstPassAcceptance,
    instrumented: report.firstPassAcceptance !== null,
    how: 'edit-distance between AI proposal and what shipped',
  };
  if (!acceptance.instrumented) notes.push('Acceptance uninstrumented: no proposals captured (e.g. streaming-only).');

  // --- Lens 3: Lift (counterfactual — worth it vs. not / vs. cheaper?) ---
  const lift: LensValue = {
    value: opts.lift ?? null,
    instrumented: opts.lift !== undefined && opts.lift !== null,
    how: opts.liftHow ?? 'counterfactual time saved — partially identified (wire a baseline or A-B to tighten)',
  };
  if (!lift.instrumented) notes.push('Lift uninstrumented: needs a measured baseline (model A/B or no-AI control).');

  // --- Lens 4: Impact (of what realized, how much mattered?) ---
  let impact: LensValue;
  if (mature.length === 0) {
    impact = { value: null, instrumented: false, how: 'impact-weighted realization' };
    notes.push('Impact uninstrumented: no matured units yet.');
  } else {
    let weighted = 0;
    let realizedWeighted = 0;
    for (const u of mature) {
      const w = impactWeight(u);
      weighted += w;
      if (u.funnel.realized) realizedWeighted += w;
    }
    impact = {
      value: weighted > 0 ? realizedWeighted / weighted : 0,
      instrumented: true,
      how: 'realized fraction weighted by blast radius + production reach',
    };
  }

  // --- Composite: the forced weighted geometric aggregator (CES θ=0) ---
  // docs/RETURN-ON-INTELLIGENCE.md §3 derives why this mean and no other: it is
  // the unique scale-invariant mean satisfying M(x·y)=M(x)·M(y), which is what
  // "quality composes the way value composes along the funnel" requires.
  const all = [realization, acceptance, lift, impact];
  const w = opts.weights ?? DEFAULT_LENS_WEIGHTS;
  const theta = opts.theta ?? 0;

  // Compose the Index for a specific Lift value (null → exclude Lift entirely).
  // The other three instrumented lenses are always included.
  const composeIndex = (liftValue: number | null): number | null => {
    const pairs: Array<{ value: number; weight: number }> = [];
    if (realization.instrumented && realization.value !== null) pairs.push({ value: realization.value, weight: w.realization });
    if (acceptance.instrumented && acceptance.value !== null) pairs.push({ value: acceptance.value, weight: w.acceptance });
    if (liftValue !== null) pairs.push({ value: liftValue, weight: w.lift });
    if (impact.instrumented && impact.value !== null) pairs.push({ value: impact.value, weight: w.impact });
    return pairs.length > 0 ? 100 * weightedPowerMean(pairs, theta) : null;
  };

  const roiIndex = composeIndex(lift.instrumented ? lift.value : null);

  // Interval-valued RoI. The counterfactual Lift is only partially identified
  // (Manski), so it arrives as a range; the aggregator is monotone in every lens,
  // so substituting Lift's [low, high] yields an Index interval that CONTAINS the
  // point. Absent a Lift range, the interval degenerates to the point.
  let roiInterval: RoIInterval = { low: roiIndex, point: roiIndex, high: roiIndex };
  if (lift.instrumented && opts.liftRange && (opts.liftRange.low !== null || opts.liftRange.high !== null)) {
    roiInterval = {
      low: composeIndex(opts.liftRange.low ?? lift.value),
      point: roiIndex,
      high: composeIndex(opts.liftRange.high ?? lift.value),
    };
  }

  if (roiIndex === 0) {
    notes.push('RoI Index is 0 because a lens collapsed — by design, no single axis can carry the score.');
  }

  // Honesty under partial instrumentation: every un-instrumented lens is a
  // necessary condition we cannot see, and unobserved conditions can only LOWER
  // the true conversion. So a partially-instrumented Index is an upper bound.
  const indexIsUpperBound = all.some((l) => !l.instrumented);
  if (indexIsUpperBound && roiIndex !== null) {
    notes.push(
      `RoI Index is an UPPER bound: ${all.filter((l) => l.instrumented).length} of 4 lenses instrumented. ` +
        'Wiring the rest can only lower it toward the truth — more measurement, more honest, never inflated.',
    );
  }

  // --- Denominator: token cost + effort tax ---
  const tokenCostUsd = report.matured.totalCostUsd;
  let effortTaxUsd = 0;
  const rate = opts.laborRatePerHour ?? null;
  if (rate !== null && rate > 0) {
    const minutes = opts.minutesPerUnitRework ?? 10;
    for (const u of mature) {
      const reworkFraction = u.acceptance !== null ? 1 - u.acceptance : 0;
      effortTaxUsd += reworkFraction * minutes * (rate / 60);
    }
  } else {
    notes.push('Effort tax = 0 (token-only): pass a labor rate to price human rework into the denominator.');
  }

  // Value-for-money uses realized value NET of rework (reworked output is worth
  // less); falls back to gross realized value when the net isn't supplied.
  const totalCost = tokenCostUsd + effortTaxUsd;
  const realizedValueForEff = report.matured.netRealizedValueUsd ?? report.matured.realizedValueUsd;
  const realizedEfficiency = totalCost > 0 ? realizedValueForEff / totalCost : null;

  return {
    lenses: { realization, acceptance, lift, impact },
    coverage: all.filter((l) => l.instrumented).length / 4,
    roiIndex,
    roiInterval,
    indexIsUpperBound,
    tokenCostUsd,
    effortTaxUsd,
    realizedEfficiency,
    notes,
  };
}

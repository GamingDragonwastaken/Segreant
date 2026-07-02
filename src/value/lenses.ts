/**
 * Return on Intelligence — the four value lenses, the composite index, and the
 * money return. (docs/RETURN-ON-INTELLIGENCE.md §3–4.)
 *
 * Two honest faces of the same per-unit evidence, kept distinct on purpose:
 *
 *   1. RoI INDEX (0..100, unitless) — the four lenses composed by a weighted
 *      GEOMETRIC mean. The geometric FORM is forced: value composes
 *      multiplicatively along the funnel, so the aggregator must satisfy
 *      M(x·y)=M(x)·M(y), and the weighted geometric mean is the
 *      constant-returns-to-scale Cobb–Douglas production function whose weights
 *      are the lenses' output ELASTICITIES (disclosed calibration, Σ=1; set them
 *      equal for the pure symmetric axiomatic index). Any lens at 0 collapses it
 *      — no single axis can be gamed.
 *
 *   2. RoI RETURN (a dimensionless ratio, ≥1 ⟺ paid for itself) — realized,
 *      rework-discounted, manual-equivalent value over the HONEST cost of the
 *      intelligence (tokens + your measured time-with-AI), then discounted by the
 *      counterfactual credit (Lift). This is value÷cost computed DIRECTLY and is
 *      kept mathematically independent of the Index: the speedup must not be
 *      counted once in a "leverage" and again inside Lift.
 *
 * A lens with no signal is `uninstrumented` (value null), excluded from the mean,
 * and reflected in coverage — the same honesty rule as the gates: unknown ≠ fault.
 *
 * This layer is modality-agnostic by design: it reads a small structural shape,
 * not git specifics, so non-coding usage can feed the same lenses later.
 */

import type { Gate, Verdict } from './gates.ts';
import { anytimeRateInterval } from './anytime.ts';

interface UnitLike {
  maturing: boolean;
  acceptance: number | null;
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

/**
 * The money number — Return on Intelligence as a real, dimensionless ratio.
 *
 *   grossRatio  = realized manual-equivalent value (net of rework) ÷ honest cost
 *   causalRatio = grossRatio × counterfactual credit (the Lift lens, applied ONCE)
 *
 * `grossRatio` is an UPPER bound on the causal return (it does not subtract what
 * you'd have done anyway); `causalRatio` is the honest headline. ≥1 ⟺ the AI
 * returned more than it cost. The cost is tokens + your measured time-with-AI
 * priced at the labor rate — so the ratio can't be inflated by ignoring the human
 * supervision the literature says dominates. Interval-valued via Lift's Manski bound.
 */
export interface RoIReturn {
  grossRatio: number | null; // realized net value ÷ honest cost (upper bound on causal)
  causalRatio: number | null; // grossRatio × counterfactual credit — the true return
  causalRange: { low: number | null; high: number | null }; // from Lift's partial-ID interval
  realizedValueUsd: number | null; // numerator: realized, rework-discounted, manual-equivalent $
  costUsd: number; // denominator: token cost + measured time-with-AI × labor rate
  counterfactualCredit: number | null; // the Lift lens value applied (null → grossRatio only)
  supervisionPriced: boolean; // true when the denominator includes measured human time (not the rework proxy)
  paysForItself: boolean | null; // (causalRatio ?? grossRatio) ≥ 1
  basis: 'usd' | 'none';
}

/**
 * The risk-adjusted read of the Index. The geometric mean already prices BALANCE
 * risk (it punishes an imbalanced lens profile); this adds ESTIMATION risk — a
 * γ-conservative certainty-equivalent that never exceeds the point estimate and
 * slides toward the partial-ID lower bound as risk-aversion γ∈[0,1] rises.
 */
export interface RoICertaintyEquivalent {
  riskAversion: number; // γ ∈ [0,1]
  index: number | null; // CE on the 0..100 Index scale
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
  // ANYTIME-VALID interval on the realization rate (docs §10): a confidence
  // sequence that holds simultaneously at every sample size, so it remains
  // honest under the way dashboards are actually used — watched continuously,
  // acted on the moment it looks good. A fixed-n interval is invalid under that
  // use; this one is not. Additive: it never changes the Index or its interval.
  realizationInterval: { low: number; high: number; level: number } | null;
  tokenCostUsd: number;
  effortTaxUsd: number;
  realizedEfficiency: number | null; // realized value / (token + effort) cost, 0..1
  returnRatio: RoIReturn; // the money number (value ÷ cost), kept independent of the Index
  certaintyEquivalent: RoICertaintyEquivalent; // γ-conservative read of the Index
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
  // --- the money number (RoI return) ---
  grossRealizedValueUsd?: number | null; // Σ over realized units of baseline manual $ × acceptance (the numerator)
  supervisionMinutes?: number | null; // measured human time-with-AI; priced into the honest denominator
  riskAversion?: number; // γ ∈ [0,1] for the Index certainty-equivalent (0 = the point estimate)
}

/**
 * Impact weight — how much a realized unit MATTERED, from observable outcome
 * signals only. Deliberately NOT line counts: LOC is a discredited value proxy
 * ("AI easily inflates the volume of code"), and weighting impact by it would
 * reintroduce exactly the lines-with-a-price-tag failure this metric rejects.
 * Instead: production reach (shipped > merged > committed-only) × durability
 * (the change survived its maturity window). Both are funnel verdicts, not size.
 */
function impactWeight(u: UnitLike): number {
  const verdict = (g: Gate) => u.funnel.results.find((r) => r.gate === g)?.verdict;
  const reach = verdict('shipped') === 'pass' ? 1.5 : verdict('merged') === 'pass' ? 1.2 : 1;
  const durability = verdict('survived') === 'pass' ? 1.25 : 1;
  return reach * durability;
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
 *   θ → 0   weighted GEOMETRIC mean (the default). Among quasi-arithmetic means
 *           the log generator is the one whose FORM is multiplicative:
 *           M(x·y)=M(x)·M(y). That form is forced by requiring quality to compose
 *           the way value composes along the funnel; equivalently it is a
 *           constant-returns-to-scale Cobb–Douglas function whose weights are the
 *           lenses' output ELASTICITIES (Σ wₖ normalized to 1). The weights are a
 *           disclosed calibration, NOT forced — set them equal and you get the
 *           symmetric axiomatic index (the unique SYMMETRIC multiplicative mean).
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
      how: 'realized fraction weighted by production reach + durability (not lines)',
    };
  }

  // --- Composite: the weighted geometric aggregator (CRS Cobb–Douglas, CES θ=0) ---
  // docs/RETURN-ON-INTELLIGENCE.md §4 derives the FORM: value composes
  // multiplicatively along the funnel, so the aggregator must satisfy
  // M(x·y)=M(x)·M(y) — which forces the log generator (geometric form). The
  // weights are the lenses' output elasticities (disclosed; equal → the symmetric
  // axiomatic index), not part of what's forced.
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
        'Measuring the rest can only lower it toward the truth — more measurement, more honest, never inflated.',
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

  // --- The money number: Return on Intelligence as a real ratio --------------
  // Numerator: realized, rework-discounted, manual-EQUIVALENT value (priced by
  // auditable task baselines, supplied as grossRealizedValueUsd) — what the kept
  // work would have cost a human. Denominator: the HONEST cost of the
  // intelligence = tokens + your measured time supervising the AI (priced at the
  // labor rate). Pricing your own time is what keeps the ratio realistic — token
  // cost alone makes a $4 feature look like a 100× return; including the hour you
  // spent driving it lands the number where the evidence does (~1–2×).
  const supervisionMin = opts.supervisionMinutes ?? null;
  const supervisionPriced = supervisionMin !== null && supervisionMin > 0 && rate !== null && rate > 0;
  const humanCostUsd = supervisionPriced ? supervisionMin! * (rate! / 60) : effortTaxUsd;
  const honestCostUsd = tokenCostUsd + humanCostUsd;
  const grossValue = opts.grossRealizedValueUsd ?? null;
  let returnRatio: RoIReturn;
  if (grossValue !== null && grossValue >= 0 && honestCostUsd > 0 && supervisionPriced) {
    const grossRatio = grossValue / honestCostUsd;
    // The counterfactual credit (Lift) is applied exactly ONCE, here — never also
    // as a separate "leverage", so the speedup is not double-counted. grossRatio
    // is therefore an UPPER bound on the causal return.
    const credit = lift.instrumented ? lift.value : null;
    const causalRatio = credit !== null ? grossRatio * credit : null;
    const loCredit = opts.liftRange?.low ?? credit;
    const hiCredit = opts.liftRange?.high ?? credit;
    returnRatio = {
      grossRatio,
      causalRatio,
      causalRange: {
        low: loCredit !== null && loCredit !== undefined ? grossRatio * loCredit : null,
        high: hiCredit !== null && hiCredit !== undefined ? grossRatio * hiCredit : null,
      },
      realizedValueUsd: grossValue,
      costUsd: honestCostUsd,
      counterfactualCredit: credit,
      supervisionPriced,
      paysForItself: (causalRatio ?? grossRatio) >= 1,
      basis: 'usd',
    };
    const headline = causalRatio ?? grossRatio;
    notes.push(
      `RoI return ${headline.toFixed(2)}× — $${grossValue.toFixed(0)} of realized work (manual-equivalent, net of rework) ` +
        `÷ $${honestCostUsd.toFixed(2)} cost (tokens + ${Math.round(supervisionMin!)} min of your time)` +
        `${causalRatio !== null ? `, credited ×${credit!.toFixed(2)} for the counterfactual` : ' (gross — wire Lift to credit the counterfactual)'}. ` +
        `${headline >= 1 ? 'It paid for itself.' : 'Below break-even.'}`,
    );
  } else {
    returnRatio = {
      grossRatio: null,
      causalRatio: null,
      causalRange: { low: null, high: null },
      realizedValueUsd: grossValue,
      costUsd: honestCostUsd,
      counterfactualCredit: lift.instrumented ? lift.value : null,
      supervisionPriced,
      paysForItself: null,
      basis: 'none',
    };
    if (grossValue !== null && !supervisionPriced) {
      notes.push('RoI return not yet priced: needs measured time-with-AI (proxy traffic) AND a labor rate to honestly cost your supervision — we will not invent a dollar return.');
    }
  }

  // --- Risk: the γ-conservative certainty-equivalent of the Index ------------
  const gamma = Math.min(1, Math.max(0, opts.riskAversion ?? 0));
  let ceIndex: number | null = null;
  if (roiIndex !== null) {
    const lowEnd = roiInterval.low ?? roiIndex;
    ceIndex = roiIndex - gamma * Math.max(0, roiIndex - lowEnd);
  }
  const certaintyEquivalent: RoICertaintyEquivalent = { riskAversion: gamma, index: ceIndex };
  if (gamma > 0 && ceIndex !== null) {
    notes.push(`Risk-adjusted (γ=${gamma.toFixed(2)}): conservative RoI Index ${ceIndex.toFixed(0)} — pulled toward the partial-ID lower bound.`);
  }

  // --- Anytime-valid interval on the realization rate (docs §10) -------------
  // A dashboard is watched continuously; only a confidence sequence stays valid
  // under that use. Computed on matured units (realized k of n), display-only:
  // it never feeds the Index, so the composite's meaning is unchanged.
  let realizationCS: { low: number; high: number; level: number } | null = null;
  if (mature.length > 0) {
    const kRealized = mature.filter((u) => u.funnel.realized).length;
    const cs = anytimeRateInterval(kRealized, mature.length, { level: 0.95 });
    realizationCS = { low: cs.low, high: cs.high, level: cs.level };
  }

  return {
    lenses: { realization, acceptance, lift, impact },
    coverage: all.filter((l) => l.instrumented).length / 4,
    roiIndex,
    roiInterval,
    indexIsUpperBound,
    realizationInterval: realizationCS,
    tokenCostUsd,
    effortTaxUsd,
    realizedEfficiency,
    returnRatio,
    certaintyEquivalent,
    notes,
  };
}

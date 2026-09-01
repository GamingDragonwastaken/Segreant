/**
 * Return on Intelligence — the four value lenses, the composite index, and the
 * money return. (docs/RETURN-ON-INTELLIGENCE.md §3–4.)
 *
 * Two honest faces of the same per-unit evidence, kept distinct on purpose:
 *
 *   1. RoI INDEX (0..100, unitless) — a DESCRIPTIVE, PREFERENCE-DEPENDENT
 *      composite of the four lenses, aggregated by a weighted GEOMETRIC mean.
 *      The geometric form follows from a stated axiom set, not from economics:
 *      assume the aggregator is quasi-arithmetic and multiplicative
 *      (M(x·y)=M(x)·M(y)), and the weighted geometric mean is what satisfies
 *      both. Whether AI value in fact composes multiplicatively along the funnel
 *      is a MODELLING CHOICE this repository has not tested. The weights are
 *      disclosed preference parameters (Σ normalized to 1), NOT estimated output
 *      elasticities — no production function has been fitted to this ledger. Any
 *      lens at 0 collapses the composite, which is a property of this aggregator
 *      (chosen so a collapsed lens cannot be scored away), not a finding that a
 *      real shortfall on one axis cannot be made up elsewhere.
 *
 *   2. RoI VALUE SCENARIO (a dimensionless observed/manual-equivalent ratio) —
 *      realized, rework-discounted manual-equivalent value over the HONEST cost
 *      of the intelligence (tokens + measured time-with-AI). It is useful
 *      accounting under stated assumptions, not causal economic evidence.
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
    spendOnRealizedUnitsUsd: number;
    acceptanceWeightedSpendUsd?: number; // realized value net of rework; falls back to gross when absent
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
 * The money number — an observed/manual-equivalent return scenario.
 *
 *   grossRatio  = realized manual-equivalent value (net of rework) ÷ honest cost
 *
 * `grossRatio` is not an identified treatment effect. A separate,
 * pre-registered randomized study must estimate incremental net benefit directly
 * before Fiscus may make an economic causal claim. The cost still includes tokens
 * + measured time-with-AI at the disclosed labor rate, so it cannot be inflated
 * by ignoring human supervision.
 */
export interface RoIReturn {
  grossRatio: number | null; // realized manual-equivalent value ÷ honest cost (observational scenario)
  causalRatio: number | null; // reserved legacy field; ordinary value reports always return null
  causalRange: { low: number | null; high: number | null }; // reserved legacy field; ordinary value reports are null
  manualEquivalentValueUsd: number | null; // numerator: realized, rework-discounted, manual-equivalent $
  costUsd: number; // denominator: token cost + measured time-with-AI × labor rate
  counterfactualCredit: number | null; // reserved legacy field; Lift is no longer used as economic credit
  supervisionPriced: boolean; // true when the denominator includes measured human time (not the rework proxy)
  // Break-even is a causal claim and is never established by this observational
  // value scenario.
  paysForItself: boolean | null; // always null on the ordinary value spine
  /**
   * The ordinary value spine has observed/manual-equivalent inputs only. A
   * randomized study will eventually supply a distinct, direct incremental
   * economic estimand; a Lift lens score is never promoted into one here.
   */
  evidenceState: 'unpriced' | 'observational_scenario';
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
  // Deprecated compatibility flag. An observed-only, weight-renormalized mean
  // is NOT generally an upper bound: measuring a missing lens can raise or lower
  // it. Kept false so older consumers do not mistake the observed score for a
  // ceiling. Read `instrumentationInterval` for the mathematically valid bound.
  indexIsUpperBound: boolean;
  // Partial-identification interval for the FULL four-lens Index when some lenses
  // are unknown. Unknown necessary lenses are evaluated at their admissible
  // endpoints 0 and 1 using the FULL fixed weight vector; the observed-only score
  // is reported separately because it need not lie at either endpoint.
  instrumentationInterval: { low: number | null; observed: number | null; high: number | null };
  // ANYTIME-VALID interval on the realization rate (docs §10): a confidence
  // sequence that holds simultaneously at every sample size, so it remains
  // honest under the way dashboards are actually used — watched continuously,
  // acted on the moment it looks good. A fixed-n interval is invalid under that
  // use; this one is not. Additive: it never changes the Index or its interval.
  realizationInterval: { low: number; high: number; level: number } | null;
  // The FULL-uncertainty read of the Index: statistical width (the realization
  // confidence sequence) and identification width (Lift's partial-ID range)
  // folded into the composite by monotone substitution — the aggregator is
  // monotone in every lens, so evaluating it at the joint lower/upper lens
  // bounds brackets the truth WITHOUT any lens-independence assumption.
  // `sources` names exactly which uncertainties entered, so the interval never
  // claims coverage it doesn't have (lenses with no interval enter as points).
  // Additive: roiInterval keeps its documented identification-only meaning.
  compositeInterval: { low: number | null; point: number | null; high: number | null; sources: string[] } | null;
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
  impact?: number | null; // orthogonal outcome impact in [0,1]; absent => uninstrumented
  impactHow?: string; // provenance for Impact; never inferred from Realization gates
  weights?: { realization: number; acceptance: number; lift: number; impact: number };
  theta?: number; // CES substitution parameter; 0 (default) = the weighted geometric mean
  // --- the money number (RoI return) ---
  grossRealizedValueUsd?: number | null; // Σ over realized units of baseline manual $ × acceptance (the numerator)
  supervisionMinutes?: number | null; // measured human time-with-AI; priced into the honest denominator
  riskAversion?: number; // γ ∈ [0,1] for the Index certainty-equivalent (0 = the point estimate)
}

/**
 * Impact is intentionally NOT reconstructed from Realization gates.
 *
 * Earlier versions weighted `merged`, `shipped`, and `survived` a second time
 * here even though those same verdicts already determine Realization. That made
 * the nominally separate Impact lens partly a duplicate durability/reach score.
 * Impact must come from an orthogonal outcome signal (business/customer reach,
 * service criticality, explicitly reported external reach, etc.) or stay unknown.
 */
/**
 * Default lens weights — DISCLOSED PREFERENCES, informed by the productivity
 * literature (docs/RETURN-ON-INTELLIGENCE.md §research), not parameters fitted
 * to any ledger. They express which signals this project chooses to weight,
 * never measured output elasticities: Lift (the counterfactual) carries the most
 * because it is the closest thing to "was it worth it"; survival-anchored
 * Realization and Impact are high; Acceptance is a faster but shallower signal.
 * An operator with different priorities should set different weights, and the
 * Index will legitimately differ. That is what a preference parameter means.
 */
export const DEFAULT_LENS_WEIGHTS = { realization: 1.0, acceptance: 0.7, lift: 1.2, impact: 1.0 } as const;

/**
 * Weighted power mean M_θ(x) = (Σ wₖ xₖ^θ / Σ wₖ)^{1/θ} — the CES family that
 * generalizes the aggregator (docs/RETURN-ON-INTELLIGENCE.md §3–4):
 *
 *   θ → 0   weighted GEOMETRIC mean (the default). Among quasi-arithmetic means
 *           the log generator is the one that is multiplicative:
 *           M(x·y)=M(x)·M(y). GIVEN those two axioms the geometric form follows
 *           — but they are assumptions about how we choose to compose lens
 *           scores, not facts established about AI value. With equal weights it
 *           is the symmetric member of that family.
 *   θ = 1   arithmetic mean (perfect substitutes — gameable; never the default).
 *   θ → −∞  minimum (Leontief, pure weakest-link).
 *
 * θ is the CES SUBSTITUTION PARAMETER, not the elasticity of substitution. The
 * elasticity is σ = 1/(1−θ): θ=0 gives σ=1 (the geometric / unit-elasticity
 * case), θ=1 gives σ=∞ (perfect substitutes), θ→−∞ gives σ→0 (Leontief). For
 * θ ≤ 0 any zero value collapses the result — a deliberate property of this
 * aggregator, so a collapsed lens cannot be scored away, and not a claim that
 * the underlying shortfall is economically uncompensable.
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

  // --- Lens 4: Impact (conditional consequence, orthogonal to Realization) ---
  const impactProvided = opts.impact !== undefined && opts.impact !== null;
  const impact: LensValue = {
    value: impactProvided ? Math.min(1, Math.max(0, opts.impact!)) : null,
    instrumented: impactProvided,
    how: opts.impactHow ?? 'orthogonal outcome impact — never inferred from merged/shipped/survived gates',
  };
  if (!impact.instrumented) {
    notes.push('Impact uninstrumented: needs an outcome signal independent of the Realization funnel.');
  }

  // --- Composite: the weighted geometric aggregator (CES θ=0) ---
  // docs/RETURN-ON-INTELLIGENCE.md §4 states the axioms this form follows from:
  // assume a quasi-arithmetic, multiplicative aggregator (M(x·y)=M(x)·M(y)) and
  // the log generator is what satisfies them. Those axioms are a declared
  // modelling choice, not an established property of AI value. The weights are
  // disclosed preference parameters (equal → the symmetric member), never fitted
  // output elasticities.
  const all = [realization, acceptance, lift, impact];
  const w = opts.weights ?? DEFAULT_LENS_WEIGHTS;
  const theta = opts.theta ?? 0;

  // Compose the Index for a specific Lift value (null → exclude Lift entirely),
  // optionally overriding the realization lens (used to substitute its
  // confidence-sequence endpoints into the composite — monotone, so endpoint
  // substitution brackets the truth). The other instrumented lenses are always
  // included at their point values.
  const composeIndex = (liftValue: number | null, realizationValue: number | null = realization.value): number | null => {
    const pairs: Array<{ value: number; weight: number }> = [];
    if (realization.instrumented && realizationValue !== null) pairs.push({ value: realizationValue, weight: w.realization });
    if (acceptance.instrumented && acceptance.value !== null) pairs.push({ value: acceptance.value, weight: w.acceptance });
    if (liftValue !== null) pairs.push({ value: liftValue, weight: w.lift });
    if (impact.instrumented && impact.value !== null) pairs.push({ value: impact.value, weight: w.impact });
    return pairs.length > 0 ? 100 * weightedPowerMean(pairs, theta) : null;
  };

  const roiIndex = composeIndex(lift.instrumented ? lift.value : null);

  // A TRUE partial-instrumentation bound must keep the full weight vector. The
  // observed-only mean above renormalizes over observed lenses, so it is a useful
  // diagnostic but not a ceiling or floor. Monotonicity of the CES/power mean
  // lets us bound the full four-lens index by substituting each unknown lens with
  // 0 (lower endpoint) and 1 (upper endpoint).
  const composeFullIndex = (unknownValue: 0 | 1): number | null => {
    const pairs: Array<{ value: number; weight: number }> = [
      { value: realization.instrumented && realization.value !== null ? realization.value : unknownValue, weight: w.realization },
      { value: acceptance.instrumented && acceptance.value !== null ? acceptance.value : unknownValue, weight: w.acceptance },
      { value: lift.instrumented && lift.value !== null ? lift.value : unknownValue, weight: w.lift },
      { value: impact.instrumented && impact.value !== null ? impact.value : unknownValue, weight: w.impact },
    ];
    return 100 * weightedPowerMean(pairs, theta);
  };
  const hasUnknownLenses = all.some((l) => !l.instrumented);
  const instrumentationInterval = hasUnknownLenses
    ? { low: composeFullIndex(0), observed: roiIndex, high: composeFullIndex(1) }
    : { low: roiIndex, observed: roiIndex, high: roiIndex };

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

  // Compatibility only: the observed-only score is never labelled an upper
  // bound. Missing dimensions are represented by the explicit full-index interval.
  const indexIsUpperBound = false;
  if (hasUnknownLenses && roiIndex !== null) {
    const low = instrumentationInterval.low;
    const high = instrumentationInterval.high;
    notes.push(
      `RoI observed-lens Index uses ${all.filter((l) => l.instrumented).length} of 4 lenses and is not a bound. ` +
        `Under the declared [0,1] lens scale, the full four-lens Index is only identified within ` +
        `${low === null ? 'unknown' : low.toFixed(1)}–${high === null ? 'unknown' : high.toFixed(1)} until the missing lenses are measured.`,
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
  const realizedValueForEff = report.matured.acceptanceWeightedSpendUsd ?? report.matured.spendOnRealizedUnitsUsd;
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
    // Lift remains a useful behavioral, partially-identified lens for the
    // composite Index. It is NOT an identified economic counterfactual: a
    // baseline-derived TSF or an injected `--tsf` has no pre-registered
    // assignment, execution adherence, value outcome, or causal estimand. Do
    // not multiply an index-scale lens score into a financial claim. Causal net
    // benefit will be a separate result supplied only by a qualified study.
    const credit = null;
    const causalRatio = null;
    returnRatio = {
      grossRatio,
      causalRatio,
      causalRange: {
        low: null,
        high: null,
      },
      manualEquivalentValueUsd: grossValue,
      costUsd: honestCostUsd,
      counterfactualCredit: credit,
      supervisionPriced,
      paysForItself: null,
      evidenceState: 'observational_scenario',
      basis: 'usd',
    };
    notes.push(
      `Observed/manual-equivalent return scenario ${grossRatio.toFixed(2)}× — $${grossValue.toFixed(0)} of realized work (manual-equivalent, net of rework) ` +
        `÷ $${honestCostUsd.toFixed(2)} cost (tokens + ${Math.round(supervisionMin!)} min of your time). ` +
        'Causal break-even is not established: a qualified randomized study needs pre-registered assignment, execution, and outcome evidence.',
    );
  } else {
    returnRatio = {
      grossRatio: null,
      causalRatio: null,
      causalRange: { low: null, high: null },
      manualEquivalentValueUsd: grossValue,
      costUsd: honestCostUsd,
      counterfactualCredit: lift.instrumented ? lift.value : null,
      supervisionPriced,
      paysForItself: null,
      evidenceState: 'unpriced',
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

  // --- Composite interval: statistical × identification width, by monotone
  // substitution of each lens's own bounds into the (monotone) aggregator.
  // Lenses without an interval enter as points and are NOT claimed as covered —
  // `sources` is the disclosure. One statistical sequence enters today (the
  // realization CS), so its level is the joint level; when more lens CSs exist,
  // split α across them before folding in.
  let compositeInterval: RoIResult['compositeInterval'] = null;
  if (roiIndex !== null) {
    const sources: string[] = [];
    const liftLow = lift.instrumented ? (opts.liftRange?.low ?? lift.value) : null;
    const liftHigh = lift.instrumented ? (opts.liftRange?.high ?? lift.value) : null;
    if (lift.instrumented && opts.liftRange && (opts.liftRange.low !== null || opts.liftRange.high !== null)) {
      sources.push('lift partial-identification range');
    }
    const realLow = realizationCS ? realizationCS.low : realization.value;
    const realHigh = realizationCS ? realizationCS.high : realization.value;
    if (realizationCS) sources.push(`realization anytime confidence sequence (level ${realizationCS.level})`);
    compositeInterval =
      sources.length > 0
        ? { low: composeIndex(liftLow, realLow), point: roiIndex, high: composeIndex(liftHigh, realHigh), sources }
        : { low: roiIndex, point: roiIndex, high: roiIndex, sources };
  }

  return {
    lenses: { realization, acceptance, lift, impact },
    coverage: all.filter((l) => l.instrumented).length / 4,
    roiIndex,
    roiInterval,
    indexIsUpperBound,
    instrumentationInterval,
    realizationInterval: realizationCS,
    compositeInterval,
    tokenCostUsd,
    effortTaxUsd,
    realizedEfficiency,
    returnRatio,
    certaintyEquivalent,
    notes,
  };
}

/**
 * Lens redundancy — the effective number of independent dimensions the lens
 * system is actually measuring across contexts:
 *
 *      d_eff = (tr R)² / tr(R²)  =  m² / Σᵢⱼ rᵢⱼ²
 *
 * where R is the correlation matrix of the LOG lens values across contexts
 * (frontier cells). d_eff = m when the lenses move independently; d_eff → 1
 * when they all track one latent factor — i.e. the "m-lens" composite is
 * really a one-number dashboard wearing m names. Correlated lenses also mean
 * the shared factor is silently overweighted in any composite, so a low d_eff
 * is a disclosure the audit trail must carry, NOT an automatic reweighting:
 * correlation alone doesn't prove redundancy (contexts may genuinely co-move).
 *
 * Honesty guards: complete-case rows only (pairwise-complete correlations can
 * yield an inconsistent R); lenses with ~zero variance across contexts carry
 * no correlation information and are dropped (named in `how`); fewer than 3
 * complete rows or 2 usable lenses → null, never an invented statistic.
 */
export interface LensRedundancy {
  dEff: number | null;
  lensCount: number; // lenses that entered the statistic
  contexts: number; // complete-case rows used
  how: string;
}

export function lensRedundancy(rows: ReadonlyArray<ReadonlyArray<number | null>>, lensNames?: string[]): LensRedundancy {
  const m0 = rows.length > 0 ? rows[0]!.length : 0;
  const names = lensNames ?? Array.from({ length: m0 }, (_, i) => `lens${i + 1}`);
  // Complete cases: every lens observed and positive (log needs > 0).
  const complete = rows.filter((r) => r.length === m0 && r.every((v) => v !== null && v > 0));
  if (complete.length < 3 || m0 < 2) {
    return { dEff: null, lensCount: 0, contexts: complete.length, how: 'needs ≥3 complete contexts and ≥2 lenses — not enough evidence to estimate correlation' };
  }
  const logs = complete.map((r) => r.map((v) => Math.log(v as number)));
  const n = logs.length;

  // Column means/sds; drop near-constant columns (no correlation information).
  const means = Array.from({ length: m0 }, (_, j) => logs.reduce((s, r) => s + r[j]!, 0) / n);
  const sds = Array.from({ length: m0 }, (_, j) => Math.sqrt(logs.reduce((s, r) => s + (r[j]! - means[j]!) ** 2, 0) / n));
  const keep: number[] = [];
  const dropped: string[] = [];
  for (let j = 0; j < m0; j++) {
    if (sds[j]! > 1e-9) keep.push(j);
    else dropped.push(names[j] ?? `lens${j + 1}`);
  }
  const m = keep.length;
  if (m < 2) {
    return { dEff: null, lensCount: m, contexts: n, how: `fewer than 2 lenses vary across contexts${dropped.length ? ` (constant: ${dropped.join(', ')})` : ''}` };
  }

  // Σᵢⱼ rᵢⱼ² over the kept columns (diagonal contributes m).
  let sumSq = m;
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const ja = keep[a]!;
      const jb = keep[b]!;
      let cov = 0;
      for (const r of logs) cov += (r[ja]! - means[ja]!) * (r[jb]! - means[jb]!);
      const rho = cov / n / (sds[ja]! * sds[jb]!);
      sumSq += 2 * rho * rho;
    }
  }
  const dEff = (m * m) / sumSq;
  return {
    dEff,
    lensCount: m,
    contexts: n,
    how:
      `effective dimensions ${dEff.toFixed(2)} of ${m} lenses over ${n} contexts` +
      (dropped.length ? ` (constant lenses excluded: ${dropped.join(', ')})` : ''),
  };
}

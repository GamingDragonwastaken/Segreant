/**
 * Lift efficiency signal — the AI-assisted SIDE of the Lift comparison, content-free.
 *
 * `liftBaseline.ts` sharpened the manual-baseline comparator (§7.1,
 * docs/RETURN-ON-INTELLIGENCE.md). It never touched the other side: measured
 * time-with-AI treats a focused three-turn session and a forty-turn session that
 * flailed to the same result identically, because both produce the same wall-clock
 * duration. This module adds a behavioral signal for THAT — how cleanly the
 * AI-assisted time was used — without reading a single token of prompt or code
 * content. See docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §1 for the full design.
 *
 * The signal: each realized, baseline-covered work unit already carries an
 * Acceptance rate (`WorkUnit.acceptance`, edit-distance between proposed and kept
 * output — structural, never semantic). Pool those rates across the units feeding
 * one Lift calculation, shrink the pool toward this ledger's OWN overall
 * first-pass-acceptance rate (never an invented external population figure — there
 * is no cited source for a "typical AI acceptance rate" the way METR provides one
 * for task-completion time, so the honest prior is the user's own broader history,
 * exactly as liftBaseline.ts shrinks toward a population prior only where a real
 * citation exists), and map the shrunk rate to a small, bounded multiplier that
 * feeds `LiftDiscounts.efficiency` in lift.ts. Reuses `shrinkRate` from
 * reliability.ts directly — the same empirical-Bayes machinery already built to
 * fix exactly this "thin sample" trap for realization rates, applied here to
 * Acceptance instead.
 */

import { shrinkRate, type BetaPrior } from './reliability.ts';

/** Same fixed, disclosed κ as liftBaseline.ts's shrinkContinuousMean — a single Lift
 * calculation typically covers too few units to separate real spread from noise the
 * way reliability.ts's cross-cell dispersion estimate can; a fixed conservative
 * constant is the honest choice over pretending to fit one from too little data. */
const PRIOR_STRENGTH = 20;

// Bounds the efficiency discount to a modest ±15% — this sharpens Lift's
// discounted point estimate, it never dominates or redefines it. Matches the
// TSF's other discounts (selection/substitution/concurrency) in being a real,
// bounded multiplier rather than a wide-open one.
const MULTIPLIER_FLOOR = 0.85;
const MULTIPLIER_CAP = 1.15;

export interface EfficiencyInputs {
  /** Acceptance rate per realized, baseline-covered unit (WorkUnit.acceptance).
   * null/undefined entries mean "no proposal captured for this unit" — excluded
   * from the pool, never treated as a zero. */
  unitAcceptance: Array<number | null | undefined>;
  /** This ledger's own overall first-pass acceptance (RealizationReport.
   * firstPassAcceptance) — the shrink-toward prior. Null when the whole ledger has
   * no captured proposals, in which case the signal is honestly uninstrumented. */
  ledgerAcceptance: number | null;
}

export interface EfficiencySignal {
  /** Feeds LiftDiscounts.efficiency directly. 1 = neutral, no adjustment. */
  multiplier: number;
  /** How many units actually had a captured Acceptance value (the pool size). */
  coveredUnits: number;
  notes: string[];
}

/** Neutral, uninstrumented signal — Lift's other discounts apply unchanged. */
function neutral(reason: string): EfficiencySignal {
  return { multiplier: 1, coveredUnits: 0, notes: [reason] };
}

export function sessionEfficiencySignal(inp: EfficiencyInputs): EfficiencySignal {
  const observed = inp.unitAcceptance.filter((a): a is number => a !== null && a !== undefined);
  if (observed.length === 0) {
    return neutral(
      'Efficiency signal uninstrumented: no realized unit in this Lift window had a captured Acceptance value.',
    );
  }
  if (inp.ledgerAcceptance === null) {
    return neutral(
      'Efficiency signal uninstrumented: this ledger has no overall Acceptance rate to shrink toward yet.',
    );
  }

  const prior: BetaPrior = { mean: inp.ledgerAcceptance, strength: PRIOR_STRENGTH };
  const n = observed.length;
  const k = observed.reduce((s, a) => s + a, 0); // fractional "expected successes" — a
  // valid Beta-Binomial generalization when each trial's own success probability
  // (not a binary win/loss) is already known, exactly the case for a rate-per-unit.
  const shrunk = shrinkRate(k, n, prior);

  const raw = 1 + (shrunk - inp.ledgerAcceptance);
  const multiplier = Math.min(MULTIPLIER_CAP, Math.max(MULTIPLIER_FLOOR, raw));

  return {
    multiplier,
    coveredUnits: n,
    notes: [
      `Efficiency signal: ${n} realized unit(s) with captured Acceptance, shrunk toward this ` +
        `ledger's own ${(inp.ledgerAcceptance * 100).toFixed(0)}% first-pass rate → ${multiplier.toFixed(2)}× ` +
        `Lift discount (algorithmic, content-free — reuses Acceptance-lens data, never reads ` +
        `proposal or commit content).`,
    ],
  };
}

/**
 * The gate ladder — the legacy coding adapter for the Realization Standard.
 *
 * A unit of coding work (a commit) travels down eight ordered gates. `unknown`
 * is first-class: a gate we cannot observe is NOT a failure, but it is equally
 * NOT evidence of success. The realization score remains a progress statistic
 * over observed gates; terminal realization is stricter and requires every gate
 * declared by this legacy contract to be confirmed pass.
 *
 * WHY A GATE CARRIES TWO FIELDS (AII-003, WP-B03). `pass | fail | unknown` has
 * no way to say that two sources disagreed. A gate fed by several signals — two
 * CI runs, a deploy that reported success and a rollback that reported failure —
 * used to resolve "any fail wins", which is a defensible decision recorded as
 * though it were an observation. The fact that both were seen simply vanished.
 *
 * So `polarity` is the truth, in four values, and `verdict` is the projection
 * the funnel and every legacy consumer still read. The projection is
 * deliberately conservative and, above all, `conflicted` NEVER becomes `pass`:
 * for the funnel's question — did this unit demonstrably clear this gate — a
 * contradiction is not a demonstration. It projects to `fail`, which preserves
 * exactly the decision the old code made while keeping the disagreement
 * visible in `polarity` and in `FunnelOutcome.conflicts`, so nothing downstream
 * has to infer back a fact that was thrown away.
 *
 * No enums (Node strip-only TS rejects them) — a const tuple + union instead.
 */

import type { EpistemicState } from '../epistemic/state.ts';
import { adaptOutcome, createWorkUnit, type OutcomeAdapter, type WorkUnit } from '../outcomes/work-unit.ts';
import type { OutcomeContract, OutcomeEvaluation } from '../outcomes/contract.ts';

export const GATE_LADDER = [
  'proposed',
  'accepted',
  'committed',
  'tested',
  'merged',
  'shipped',
  'survived',
  'clean',
] as const;

export type Gate = (typeof GATE_LADDER)[number];

/** The legacy three-valued projection. Kept because everything downstream reads it. */
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface GateResult {
  gate: Gate;
  /**
   * The four-valued truth: `conflicted` means this gate was both supported and
   * refuted by the evidence available, which `verdict` cannot express.
   */
  polarity: EpistemicState;
  /** The conservative projection of `polarity`. See `verdictFromPolarity`. */
  verdict: Verdict;
  detail: string;
}

/**
 * Project four-valued polarity onto the legacy verdict at the compatibility
 * edge, and nowhere else.
 *
 * `conflicted -> 'fail'` is the load-bearing line. It must never be `'pass'`
 * (a contradiction is not a demonstration) and it is deliberately not
 * `'unknown'` either, because that would launder an observed failure into an
 * absence of evidence — the exact substitution the four-valued state exists to
 * refuse, applied in the opposite direction.
 */
export function verdictFromPolarity(polarity: EpistemicState): Verdict {
  switch (polarity) {
    case 'supported': return 'pass';
    case 'refuted': return 'fail';
    case 'conflicted': return 'fail';
    case 'unknown': return 'unknown';
  }
}

/**
 * Read four-valued polarity back out of a legacy three-valued verdict.
 *
 * This is the compatibility edge in the other direction: a row persisted or
 * transmitted as `pass | fail | unknown` cannot express conflict, so it never
 * yields `conflicted`. That is a real limit of the stored form, not a claim
 * that no disagreement occurred — which is why new evidence goes through
 * `aggregatePolarity` and only historical rows come through here.
 */
export function polarityFromVerdict(verdict: Verdict): EpistemicState {
  switch (verdict) {
    case 'pass': return 'supported';
    case 'fail': return 'refuted';
    case 'unknown': return 'unknown';
  }
}

/** Build a `GateResult` from a legacy verdict, for fixtures and stored rows. */
export function gateResultFromVerdict(gate: Gate, verdict: Verdict, detail: string): GateResult {
  return { gate, polarity: polarityFromVerdict(verdict), verdict, detail };
}

/**
 * Aggregate independent observations of one proposition into four-valued state.
 *
 * Both directions observed is `conflicted`, not "the bad one wins". Neither is
 * `unknown`, not `false`.
 */
export function aggregatePolarity(observations: Iterable<boolean>): EpistemicState {
  let sawSupport = false;
  let sawRefutation = false;
  for (const observation of observations) {
    if (observation) sawSupport = true;
    else sawRefutation = true;
  }
  if (sawSupport && sawRefutation) return 'conflicted';
  if (sawRefutation) return 'refuted';
  if (sawSupport) return 'supported';
  return 'unknown';
}

export interface GateMeta {
  label: string;
  proves: string;
  source: 'git' | 'proxy' | 'signal';
}

export const GATE_META: Record<Gate, GateMeta> = {
  proposed: { label: 'Proposed', proves: 'AI originated this work', source: 'proxy' },
  accepted: { label: 'Accepted', proves: 'kept without heavy rewriting', source: 'proxy' },
  committed: { label: 'Committed', proves: 'entered version control', source: 'git' },
  tested: { label: 'Tested', proves: 'the test suite passed', source: 'signal' },
  merged: { label: 'Merged', proves: 'passed review into mainline', source: 'signal' },
  shipped: { label: 'Shipped', proves: 'reached production', source: 'signal' },
  survived: { label: 'Survived', proves: 'still present after the maturity window', source: 'git' },
  clean: { label: 'Clean', proves: 'never reverted, no linked incident', source: 'git' },
};

export interface FunnelOutcome {
  results: GateResult[];
  reachedIndex: number; // deepest contiguous pass before any fail (-1 if none)
  reached: Gate | null;
  diedAt: Gate | null; // first FAIL on the ladder, null if none
  diedAtIndex: number | null;
  realized: boolean; // every gate in this declared legacy contract is confirmed pass
  /**
   * Gates where the evidence both supported and refuted the proposition.
   * Surfaced rather than resolved: a consumer that needs a single answer reads
   * `verdict`, but nothing has to reconstruct the disagreement from it.
   */
  conflicts: Gate[];
  passes: number;
  fails: number;
  unknowns: number;
  instrumented: number; // passes + fails
  realizationScore: number; // passes / instrumented, 0 when nothing instrumented
}

const CODING_OUTCOME_CONTRACT: OutcomeContract = Object.freeze({
  id: 'coding-gate-lifecycle',
  requiredPredicates: GATE_LADDER,
});

/** Canonical adapter for coding's legacy gate contract. */
export const CODING_OUTCOME_ADAPTER: OutcomeAdapter = Object.freeze({
  id: 'coding-gate-lifecycle-v1',
  contract: CODING_OUTCOME_CONTRACT,
  resolve: (_predicate: string, unit: WorkUnit): EpistemicState => {
    const states = unit.context.gateStates;
    if (states === null || typeof states !== 'object' || Array.isArray(states)) return 'unknown';
    const state = (states as Record<string, unknown>)[_predicate];
    return state === 'supported' || state === 'refuted' || state === 'conflicted' || state === 'unknown'
      ? state
      : 'unknown';
  },
});

/** Evaluate coding gates through the domain-neutral OutcomeAdapter contract. */
export interface CodingOutcomeEvaluation extends OutcomeEvaluation {
  /** Compatibility projection retaining the coding funnel's ordered gate detail. */
  readonly funnel: FunnelOutcome;
}

export function evaluateCodingOutcome(verdicts: Readonly<Record<Gate, GateResult>>): CodingOutcomeEvaluation {
  const unit = createWorkUnit({
    id: 'coding-outcome-evaluation',
    kind: 'coding_commit',
    startedAtMs: 0,
    endedAtMs: 0,
    context: {
      gateStates: Object.fromEntries(GATE_LADDER.map((gateName) => [gateName, verdicts[gateName].polarity])),
    },
  });
  const adapted = adaptOutcome(unit, CODING_OUTCOME_ADAPTER);
  return Object.freeze({
    ...adapted.evaluation,
    funnel: scoreFunnelProjection(verdicts, adapted.evaluation.status === 'confirmed'),
  });
}

/**
 * Terminal realization BOUNDS over a set of (matured) funnel outcomes — the
 * partial-identification answer to "what share of this work is realized?" when
 * some gates are unobserved. Per-unit:
 *
 *   lower: confirmed realized (every required legacy gate confirmed pass)
 *   upper: not observed dead (no fail at any observed gate)
 *
 * The truth is provably inside [lower, upper]; the width IS the unobserved
 * region. This exists so the per-unit progress score (realizationScore below,
 * which reads "of the gates we could judge, how many passed") is never misread
 * as a realization probability: a unit with four early passes and four unknown
 * gates has a perfect progress score but sits strictly between the bounds, and
 * this interval says so out loud. Wiring more gates narrows the interval — the
 * honest direction: measurement tightens, never inflates.
 */
export interface TerminalRealizationBounds {
  lower: number; // share confirmed realized
  upper: number; // share not observed to have died
  n: number; // units the bounds are over
}

export function terminalRealizationBounds(outcomes: ReadonlyArray<FunnelOutcome>): TerminalRealizationBounds {
  const n = outcomes.length;
  if (n === 0) return { lower: 0, upper: 0, n: 0 };
  let confirmed = 0;
  let notDead = 0;
  for (const o of outcomes) {
    if (o.realized) confirmed += 1;
    if (o.diedAt === null) notDead += 1;
  }
  return { lower: confirmed / n, upper: notDead / n, n };
}

/**
 * Serial realization — the ORDERED survival estimate S_G = Π q_g, where each
 * q_g = P(pass at gate g | still alive entering g) is estimated among units
 * that had no observed fail at any earlier gate, using only observed verdicts
 * at g. This is the survival-chain quantity the gate-average score is NOT:
 * the average treats gates as an unordered checklist; the product prices the
 * fact that realization requires surviving EVERY stage in sequence.
 *
 * Honesty rules: a gate with zero instrumented verdicts among alive units
 * contributes nothing to the product and is listed in `skipped` — so S_G is an
 * estimate over the OBSERVED portion of the chain, and the caller must show
 * `skipped` beside it (an unshown skipped gate would silently assume q=1).
 * Null when no gate is instrumented at all — never an invented number.
 */
export interface SerialGateEstimate {
  gate: Gate;
  alive: number; // units with no observed fail before this gate
  passes: number;
  fails: number;
  q: number | null; // passes / (passes + fails) among alive, null if uninstrumented
}

export interface SerialRealization {
  sG: number | null; // Π q_g over instrumented gates, null if none instrumented
  gates: SerialGateEstimate[];
  included: Gate[]; // gates whose q entered the product
  skipped: Gate[]; // gates with no observed verdicts among alive units (assumed-nothing, disclosed)
}

export function serialRealization(outcomes: ReadonlyArray<FunnelOutcome>): SerialRealization {
  const gates: SerialGateEstimate[] = [];
  const included: Gate[] = [];
  const skipped: Gate[] = [];
  let product = 1;
  let anyIncluded = false;

  for (let gi = 0; gi < GATE_LADDER.length; gi++) {
    const g = GATE_LADDER[gi]!;
    let alive = 0;
    let passes = 0;
    let fails = 0;
    for (const o of outcomes) {
      // Alive entering g: no observed fail at any earlier gate. Unknown earlier
      // verdicts do not kill — they are absence of evidence, not evidence of death.
      let dead = false;
      for (let j = 0; j < gi; j++) {
        if (o.results[j]!.verdict === 'fail') {
          dead = true;
          break;
        }
      }
      if (dead) continue;
      alive += 1;
      const v = o.results[gi]!.verdict;
      if (v === 'pass') passes += 1;
      else if (v === 'fail') fails += 1;
    }
    const instrumented = passes + fails;
    const q = instrumented > 0 ? passes / instrumented : null;
    gates.push({ gate: g, alive, passes, fails, q });
    if (q === null) {
      skipped.push(g);
    } else {
      included.push(g);
      product *= q;
      anyIncluded = true;
    }
  }

  return { sG: anyIncluded ? product : null, gates, included, skipped };
}

/**
 * Score a unit's funnel from a verdict per gate. Funnel semantics:
 *  - the unit "reaches" the deepest gate that passed before the first failure;
 *  - `unknown` gates do not stop the funnel and do not count as reached;
 *  - terminal `realized` means every gate this legacy coding contract declares
 *    necessary is confirmed pass. An unknown gate is unresolved, not success.
 */
export function scoreFunnel(verdicts: Record<Gate, GateResult>): FunnelOutcome {
  return evaluateCodingOutcome(verdicts).funnel;
}

function scoreFunnelProjection(verdicts: Record<Gate, GateResult>, realized: boolean): FunnelOutcome {
  const results = GATE_LADDER.map((g) => verdicts[g]);

  let passes = 0;
  let fails = 0;
  let unknowns = 0;
  let diedAt: Gate | null = null;
  let diedAtIndex: number | null = null;

  for (let i = 0; i < GATE_LADDER.length; i++) {
    const v = results[i]!.verdict;
    if (v === 'pass') passes += 1;
    else if (v === 'fail') {
      fails += 1;
      if (diedAt === null) {
        diedAt = GATE_LADDER[i]!;
        diedAtIndex = i;
      }
    } else unknowns += 1;
  }

  // Deepest pass strictly before the first failure.
  const limit = diedAtIndex ?? GATE_LADDER.length;
  let reachedIndex = -1;
  for (let i = 0; i < limit; i++) {
    if (results[i]!.verdict === 'pass') reachedIndex = i;
  }

  // The canonical coding adapter is the terminal-status authority. It consumes
  // the four-valued gate states, so unknown and conflicted evidence cannot become
  // confirmation through the legacy three-valued projection.
  const conflicts = GATE_LADDER.filter((gateName) => verdicts[gateName].polarity === 'conflicted');
  const instrumented = passes + fails;

  // Realization score is MONOTONE along the necessary-condition chain: a unit
  // cannot bank gates it passed AFTER an earlier required gate failed — once it
  // dies at `diedAt`, deeper passes are moot (its fate was sealed there). With no
  // failure it is "of the gates we could judge, how many passed"; with a failure
  // it is "passes before death ÷ (those passes + the failing gate)". This keeps
  // `unknown` neutral (never counted) while refusing to reward post-fail passes.
  let realizationScore: number;
  if (diedAtIndex === null) {
    realizationScore = instrumented > 0 ? passes / instrumented : 0;
  } else {
    let passesBeforeDeath = 0;
    for (let i = 0; i < diedAtIndex; i++) if (results[i]!.verdict === 'pass') passesBeforeDeath += 1;
    realizationScore = passesBeforeDeath / (passesBeforeDeath + 1);
  }

  return {
    results,
    reachedIndex,
    reached: reachedIndex >= 0 ? GATE_LADDER[reachedIndex]! : null,
    diedAt,
    diedAtIndex,
    realized,
    conflicts,
    passes,
    fails,
    unknowns,
    instrumented,
    realizationScore,
  };
}

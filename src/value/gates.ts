/**
 * The gate ladder — the spine of the Realization Standard (docs/THE-STANDARD.md).
 *
 * A unit of work (a commit) travels down eight ordered gates. Each gate returns
 * pass / fail / unknown. `unknown` is first-class: a gate we cannot observe is
 * NOT a failure, and it never inflates or deflates the score. The realization
 * score is "of the checks we could make, how many passed".
 *
 * No enums (Node strip-only TS rejects them) — a const tuple + union instead.
 */

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
export type Verdict = 'pass' | 'fail' | 'unknown';

export interface GateResult {
  gate: Gate;
  verdict: Verdict;
  detail: string;
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
  realized: boolean; // no fail anywhere AND survived+clean both confirmed pass
  passes: number;
  fails: number;
  unknowns: number;
  instrumented: number; // passes + fails
  realizationScore: number; // passes / instrumented, 0 when nothing instrumented
}

/**
 * Terminal realization BOUNDS over a set of (matured) funnel outcomes — the
 * partial-identification answer to "what share of this work is realized?" when
 * some gates are unobserved. Per-unit:
 *
 *   lower: confirmed realized (no fail anywhere AND durability confirmed pass)
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
 *  - it is "realized" only if nothing failed and the two durability gates
 *    (survived, clean) are confirmed pass — so maturing units are never realized.
 */
export function scoreFunnel(verdicts: Record<Gate, GateResult>): FunnelOutcome {
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

  const realized =
    diedAt === null && verdicts.survived.verdict === 'pass' && verdicts.clean.verdict === 'pass';
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
    passes,
    fails,
    unknowns,
    instrumented,
    realizationScore,
  };
}

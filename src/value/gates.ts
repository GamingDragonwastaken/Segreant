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

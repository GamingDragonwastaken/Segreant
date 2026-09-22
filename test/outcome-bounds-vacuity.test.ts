/**
 * Zero observations produced an upper bound of zero.
 *
 * `outcomeBounds` reports partial-identification bounds on the realized share:
 * the lower bound counts only confirmed outcomes, the upper bound excludes only
 * outcomes refuted without ambiguity, and everything unresolved stays possible.
 * Over an empty list it returned `{lower: 0, upper: 0}`.
 *
 * An upper bound of 0 is the strongest negative claim this function can make.
 * It says: no more than zero percent of these outcomes realized, and no
 * evidence could raise it. That is what ten observed failures look like. From
 * zero evaluations the honest interval is the whole one -- nothing has been
 * observed, so nothing has been excluded, and every share between 0 and 1
 * remains consistent with what is known.
 *
 * `n: 0` TRAVELS BESIDE IT AND IS NOT A SUBSTITUTE. The field was always there
 * and a careful consumer could read it. That is exactly the shape this program
 * has refused repeatedly: a figure whose meaning depends on a second field the
 * reader has to know to check is a figure that will be read wrong, and the
 * number itself has to be the honest one. Hard rule 1 -- every figure carries
 * its basis -- is not satisfied by the basis being available nearby.
 *
 * THE SAME CASE ALREADY HAD THE RIGHT ANSWER ONE MODULE OVER, WHICH IS THE
 * FINDING. `anytimeRateInterval` in `src/value/anytime.ts` handles n <= 0 by
 * returning `[0, 1]` with the comment "no evidence -> the whole interval,
 * honestly". Two functions in one repository computing an interval over a
 * realized share, disagreeing on the one input where the answer is not a matter
 * of taste. Consistency here is not tidiness: a consumer that reads both and
 * finds them disagreeing about an empty sample has no way to tell which is the
 * convention.
 *
 * LATENT, AND FIXED ANYWAY. No caller in `src/` passes an empty array today --
 * `outcomeBounds` has no `src/` caller at all, and `src/causal/precision.ts`
 * uses a differently-typed field of the same name. This kernel exists to refuse
 * the collapse between "no evidence" and "evidence of none", and a kernel that
 * would commit it on its first empty input is not doing that job because
 * nobody has called it yet.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the non-empty bounds are calibrated for
 * any other reason: they are exact counts over terminal status, which is what
 * partial identification means here and all it means. That a small non-empty
 * sample is adequate -- `n: 3` still produces a narrow interval from three
 * observations, and this function offers no anytime-valid coverage guarantee
 * the way `anytimeRateInterval` does. And nothing about outcomes that were
 * never evaluated, which is the same permanent limit every local measure has.
 *
 * Recorded at D-191.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOutcomeContract,
  outcomeBounds,
  type OutcomeContract,
  type OutcomeEvaluation,
} from '../src/outcomes/contract.ts';
import { anytimeRateInterval } from '../src/value/anytime.ts';
import type { EpistemicState } from '../src/epistemic/state.ts';

const contract: OutcomeContract = {
  id: 'software-shipped-clean',
  requiredPredicates: ['tested', 'merged', 'shipped', 'survived', 'clean'],
};

function evaluate(states: Partial<Record<string, EpistemicState>>): OutcomeEvaluation {
  return evaluateOutcomeContract(contract, (predicate) => states[predicate] ?? 'unknown');
}

test('zero evaluations bound the realized share at [0, 1], not at zero', () => {
  assert.deepEqual(outcomeBounds([]), {
    lower: 0,
    upper: 1,
    n: 0,
    confirmed: 0,
    failed: 0,
    unresolved: 0,
    conflicted: 0,
  });
});

test('the empty case agrees with the anytime interval on the same question', () => {
  // Two functions over a realized share in one repository. They must not
  // disagree about an empty sample, or a consumer reading both has no
  // convention to follow.
  const empty = outcomeBounds([]);
  const anytime = anytimeRateInterval(0, 0);
  assert.equal(empty.lower, anytime.low);
  assert.equal(empty.upper, anytime.high);
});

test('an all-refuted sample is what an upper bound of zero actually means', () => {
  // The claim the empty case was making. This is the state that licenses it,
  // and it is a measurement rather than an absence of one.
  const evaluations: OutcomeEvaluation[] = [
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'refuted', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'refuted', survived: 'supported', clean: 'supported' }),
  ];
  const bounds = outcomeBounds(evaluations);
  assert.equal(bounds.upper, 0, 'two observed failures exclude every positive share');
  assert.equal(bounds.n, 2, 'and the two states are told apart by n, which is now not the only thing telling them apart');
});

test('the four-evaluation example is unchanged, value for value', () => {
  // The guard, reproducing the pre-existing example in
  // test/outcome-contract.test.ts exactly. Widening the empty case must not
  // move a single number on any populated one.
  const evaluations: OutcomeEvaluation[] = [
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'supported', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'unknown', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'conflicted', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'refuted', survived: 'supported', clean: 'supported' }),
  ];
  assert.deepEqual(outcomeBounds(evaluations), {
    lower: 0.25,
    upper: 0.75,
    n: 4,
    confirmed: 1,
    failed: 1,
    unresolved: 1,
    conflicted: 1,
  });
});

test('a single confirmed evaluation still pins both bounds at one', () => {
  // The other end of the same guard: a populated sample with no ambiguity
  // still identifies the share exactly, which the widened empty case must not
  // soften into an interval.
  const bounds = outcomeBounds([
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'supported', survived: 'supported', clean: 'supported' }),
  ]);
  assert.deepEqual(bounds, {
    lower: 1,
    upper: 1,
    n: 1,
    confirmed: 1,
    failed: 0,
    unresolved: 0,
    conflicted: 0,
  });
});

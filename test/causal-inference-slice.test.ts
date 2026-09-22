/**
 * The plan stopped bounding the family for the right reason and said the wrong
 * one.
 *
 * WHAT I EXPECTED TO FIND, AND DID NOT. A `CausalInferencePlan` registers
 * `sliceIds` in advance and `plannedInferenceActs` sizes the whole error budget
 * from them, so reporting on an unregistered slice would spend budget from a
 * denominator computed without it. I went looking for a family-wise guarantee
 * covering a slice the plan never declared. It is not there: `actsExceedPlan`
 * already includes
 * `[...slices].some((sliceId) => !registeredSlices.has(sliceId))`, so the basis
 * correctly falls to `recorded_acts_only`. The arithmetic is sound, and this
 * file records that it is -- a test that went looking for a hole and found none
 * has still established something worth keeping.
 *
 * WHAT IS ACTUALLY WRONG. `actsExceedPlan` is the union of three distinct
 * conditions -- too many budgeted acts, too many looks, and an act on an
 * unregistered slice -- and exactly one message is emitted for all three:
 *
 *   "The recorded acts exceeded the pre-registered plan"
 *
 * Measured on a plan of 4 looks x 2 endpoints x 1 slice = 8 acts, with ONE act
 * recorded on an unregistered slice, that is what the operator is told. Nothing
 * was exceeded. One act against a plan of eight, and the reader is sent looking
 * for extra looks that do not exist while the real reason -- a slice the plan
 * never registered -- is named nowhere. Same defect class as D-158: a correct
 * refusal that names the wrong reason.
 *
 * AND THE TWO BASIS LINES CONTRADICT EACH OTHER. The limitations carry both
 * "Basis: recorded acts only" and "Basis: a pre-registered plan of 4 look(s)
 * x ...", one after the other, with nothing marking the second as the plan that
 * no longer applies.
 *
 * The slice id was also unvalidated at the reporting boundary: `validatePlan`
 * refuses an empty slice id inside a plan, while `recordInferentialActs`
 * accepted one, so an act could be keyed on no slice identity at all while the
 * plan describing it could not.
 *
 * Recorded at D-160.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openCausalInferenceLedger,
  recordInferentialActs,
  summarizeInferenceMultiplicity,
  type CausalInferencePlan,
} from '../src/causal/inference-ledger.ts';

const STUDY = { studyId: 'study-slice', protocolHash: 'a'.repeat(64) };

function plan(overrides: Partial<CausalInferencePlan> = {}): CausalInferencePlan {
  return {
    declaredAtMs: 1_700_000_000_000,
    maxLooks: 4,
    endpointsPerLook: 2,
    sliceIds: ['slice:registered'],
    targetFamilywiseErrorRate: 0.05,
    ...overrides,
  };
}

function act(sliceId: string, evidenceDigest = 'digest:one') {
  return {
    endpoint: 'cost' as const,
    sliceId,
    evidenceDigest,
    estimandId: 'estimand:itt',
    includedUnits: 100,
    kind: 'interval_report' as const,
    actAlpha: 0.05 / 8,
    reportedAtMs: 1_700_000_001_000,
  };
}

test('the registered-slice case is unchanged, and this pins that nothing churns', () => {
  // The control. An act on a slice the plan registered must still summarise as
  // a pre-registered plan, or the fix below would be withholding from everyone.
  const ledger = recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan() }),
    [act('slice:registered')],
  );
  const summary = summarizeInferenceMultiplicity(ledger);

  assert.equal(summary.basis, 'pre_registered_plan');
  assert.equal(summary.chainIntact, true);
});

test('an unregistered slice withholds the guarantee, and this records that it already did', () => {
  // NOT A NEW FIX. `actsExceedPlan` already caught this before D-160 and the
  // arithmetic was right. The assertion is kept because it is the property that
  // matters most in this module, and a reader should not have to re-derive that
  // it holds.
  const ledger = recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan() }),
    [act('slice:never-declared')],
  );
  assert.equal(summarizeInferenceMultiplicity(ledger).basis, 'recorded_acts_only');
});

test('the reason given is the reason that fired, and it names the slice', () => {
  // THE ACTUAL DEFECT. One act against a plan of 4 x 2 x 1 = 8 exceeds nothing,
  // and the operator was told "The recorded acts exceeded the pre-registered
  // plan" -- sent looking for extra looks that do not exist, while the real
  // reason went unmentioned.
  const summary = summarizeInferenceMultiplicity(recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan() }),
    [act('slice:never-declared')],
  ));

  assert.ok(
    summary.limitations.some((line) => line.includes('slice:never-declared')),
    `a limitation must name the unregistered slice; got ${JSON.stringify(summary.limitations)}`,
  );
  assert.equal(
    summary.limitations.some((line) => /exceeded the pre-registered plan/.test(line)),
    false,
    'nothing was exceeded: one act was recorded against a plan of eight',
  );
});

test('a genuine overrun still says it was an overrun', () => {
  // The other side of the same message. Fixing the misdescription must not cost
  // the accurate description of the condition that really is a count overrun.
  const registered = plan({ maxLooks: 1, endpointsPerLook: 1, sliceIds: ['slice:registered'] });
  let ledger = openCausalInferenceLedger({ ...STUDY, plan: registered });
  for (let look = 1; look <= 3; look += 1) {
    ledger = recordInferentialActs(ledger, [act('slice:registered', `digest:${look}`)]);
  }
  const summary = summarizeInferenceMultiplicity(ledger);

  assert.equal(summary.basis, 'recorded_acts_only');
  assert.ok(
    summary.limitations.some((line) => /exceed|more .*than the plan|overrun/i.test(line)),
    `a real overrun must still be described as one; got ${JSON.stringify(summary.limitations)}`,
  );
});

test('the plan line does not read as though the plan is still in force', () => {
  // Two "Basis:" lines sat one after the other -- "recorded acts only" and "a
  // pre-registered plan of 4 look(s) x ..." -- with nothing marking the second
  // as the plan that no longer applies.
  const summary = summarizeInferenceMultiplicity(recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan() }),
    [act('slice:never-declared')],
  ));
  const planLine = summary.limitations.find((line) => line.includes('pre-registered plan of'));

  assert.notEqual(planLine, undefined);
  assert.doesNotMatch(
    planLine!,
    /^Basis:/,
    'a plan that no longer bounds the family must not be presented as the basis',
  );
});

test('the act on an unregistered slice is still recorded, because the look happened', () => {
  // The half that is easy to get wrong in the other direction. Refusing the act
  // would lose a look that was really taken, and an uncounted look is the exact
  // failure this ledger exists to prevent.
  const ledger = recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan() }),
    [act('slice:never-declared')],
  );
  const summary = summarizeInferenceMultiplicity(ledger);

  assert.equal(ledger.acts.length, 1);
  assert.equal(summary.looks, 1);
  assert.equal(summary.actsInErrorBudget, 1);
});

test('one unregistered slice among registered ones names only the unregistered one', () => {
  // A guarantee is not divisible: if any recorded act falls outside the family
  // the denominator described, the denominator does not describe what happened.
  // The message must name the slice that broke it and not the ones that did not.
  const ledger = recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: plan({ sliceIds: ['slice:a', 'slice:b'] }) }),
    [act('slice:a'), act('slice:c', 'digest:two')],
  );
  const summary = summarizeInferenceMultiplicity(ledger);

  assert.equal(summary.basis, 'recorded_acts_only');
  const named = summary.limitations.find((line) => line.includes('slice:c'));
  assert.notEqual(named, undefined, `a limitation must name slice:c; got ${JSON.stringify(summary.limitations)}`);
  assert.equal(named!.includes('slice:a'), false, 'a registered slice must not be named as the problem');
});

test('a plan-less ledger is unaffected, because it claims no guarantee to lose', () => {
  // With no plan there is no registered family, so every slice is as good as
  // any other and the basis was already `recorded_acts_only`.
  const ledger = recordInferentialActs(
    openCausalInferenceLedger({ ...STUDY, plan: null }),
    [act('slice:anything')],
  );
  const summary = summarizeInferenceMultiplicity(ledger);

  assert.equal(summary.basis, 'recorded_acts_only');
  assert.equal(summary.looks, 1);
});

test('an act with no slice identity is refused, as a plan already refuses one', () => {
  // `validatePlan` rejects an empty slice id inside a plan. The reporting path
  // accepted one, so an act could be keyed on no slice identity at all while
  // the plan describing it could not.
  for (const bad of ['', '   ']) {
    assert.throws(
      () => recordInferentialActs(openCausalInferenceLedger({ ...STUDY, plan: null }), [act(bad)]),
      /slice/i,
      `empty slice id ${JSON.stringify(bad)} must be refused`,
    );
  }
});

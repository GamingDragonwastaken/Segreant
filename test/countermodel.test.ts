/**
 * Countermodels and assumption fragility (WP-B04).
 *
 * A `Claim` carries its assumptions as prose and the reconciliation run carries
 * five `conditions` in the same shape. Both are honest; neither is actionable.
 * A countermodel is the world in which one of them is false, written down
 * concretely enough to be checked, together with the observation that would rule
 * it out — or `null`, which is the answer that matters most here.
 *
 * TWO FAILURE MODES THIS FILE EXISTS TO PIN, and they pull in opposite
 * directions.
 *
 *   The machinery must not let a claim be made to LOOK robust. Marking every
 *   countermodel excluded and recording no reason is the cheapest way to do
 *   that, so `excluded` requires an `excludedBy`; and returning "no live
 *   countermodels" for a claim nobody wrote countermodels for is the second
 *   cheapest, so `robustnessAssessed` is false while any assumption is
 *   uncovered.
 *
 *   It must also not be uniformly pessimistic, which would make it decoration.
 *   The billing application below is driven by evidence on the run in both
 *   directions: four worlds nothing can exclude, one that names a real
 *   discriminator an operator can go and close, and one the evidence positively
 *   ESTABLISHES when the residual goes negative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAssumptionFragility, countermodel } from '../src/epistemic/countermodel.ts';
import { reconciliationCountermodels } from '../src/billing/countermodels.ts';
import { PERMANENT_CONDITIONS, type ReconciliationRun } from '../src/billing/reconcile.ts';

const WORLD = 'the rate card over-prices on-path traffic';
const BECOMES = 'the residual understates off-path spend by the over-estimate';

function run(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  return {
    status: 'reconciled_with_residual',
    observationRunId: 'observation:1',
    declaredScopeId: 'scope:1',
    providerProjectRef: 'project-a',
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_086_400_000,
    currency: 'USD',
    materialityUsd: 0.5,
    providerReportedMicros: 1_334_567,
    localCapturedMicros: 1_000_000,
    unexplainedVarianceMicros: 334_567,
    coverage: { providerDays: 2, localDays: 2, daysWithBoth: 2, providerOnlyDays: 0, localOnlyDays: 0, materialDays: 1 },
    days: [],
    offPathBound: 'upper_bound_conditional',
    snapshotStability: 'single_observation',
    unstableDayStartMs: [],
    providerSourceKind: 'provider_api_pull',
    conditions: PERMANENT_CONDITIONS,
    trust: 'scope_conditional_reconciliation',
    excludedFrom: ['request_metered_spend', 'budget_enforcement', 'roi', 'model_recommendations'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The kernel primitive
// ---------------------------------------------------------------------------

test('a world cannot be ruled out by nothing', () => {
  // The cheapest way to make a claim look robust is to mark its countermodels
  // excluded and record no reason. That has to be impossible rather than
  // discouraged.
  assert.throws(
    () => countermodel({
      id: 'countermodel:1', violates: 'a', world: WORLD, claimBecomes: BECOMES,
      excludedBy: null, status: 'excluded',
    }),
    /marked excluded but names nothing that excluded it/,
  );
});

test('a countermodel pending an observation must name the observation', () => {
  // `unknown` means the discriminator EXISTS and has not been made. With no
  // discriminator there is nothing to wait for, and calling it pending would
  // dress a permanent condition up as an errand.
  assert.throws(
    () => countermodel({
      id: 'countermodel:2', violates: 'a', world: WORLD, claimBecomes: BECOMES,
      excludedBy: null, status: 'unknown',
    }),
    /with no discriminator it is live/,
  );
});

test('a countermodel must violate an assumption the claim actually states', () => {
  // Free-floating doubt attaches to nothing and can be discharged by nothing.
  // It is also the signature of the opposite defect: an assumption the claim
  // relies on and has failed to declare.
  assert.throws(
    () => assessAssumptionFragility(['a'], [countermodel({
      id: 'countermodel:3', violates: 'b', world: WORLD, claimBecomes: BECOMES,
      excludedBy: null, status: 'live',
    })]),
    /violates an assumption this claim does not state: b/,
  );
});

test('no countermodels is not robustness, and the assessment refuses to imply it', () => {
  // THE ASSERTION THIS MODULE EXISTS FOR. An empty `fragileAssumptions` reads as
  // "nothing threatens this claim" unless something says nobody looked. It is
  // the same rule completeness applies to absence inference, one level up.
  const assessment = assessAssumptionFragility(['a', 'b'], []);
  assert.deepEqual([...assessment.fragileAssumptions], [], 'nothing is known to be fragile');
  assert.equal(assessment.robustnessAssessed, false, 'and that says nothing, because nothing was examined');
  assert.deepEqual([...assessment.uncoveredAssumptions], ['a', 'b']);

  // One assumption covered is still not all of them.
  const partial = assessAssumptionFragility(['a', 'b'], [countermodel({
    id: 'countermodel:4', violates: 'a', world: WORLD, claimBecomes: BECOMES,
    excludedBy: 'a provider line-item join priced at billed rates', status: 'excluded',
  })]);
  assert.equal(partial.robustnessAssessed, false);
  assert.deepEqual([...partial.uncoveredAssumptions], ['b']);
  assert.deepEqual(partial.excluded.map((item) => item.id), ['countermodel:4']);

  // And a fully covered claim can genuinely reach robustnessAssessed, or the
  // flag would be permanently false and therefore meaningless.
  const covered = assessAssumptionFragility(['a'], [countermodel({
    id: 'countermodel:5', violates: 'a', world: WORLD, claimBecomes: BECOMES,
    excludedBy: 'a provider line-item join priced at billed rates', status: 'excluded',
  })]);
  assert.equal(covered.robustnessAssessed, true);
  assert.deepEqual([...covered.fragileAssumptions], []);
});

test('the permanently conditional is separated from the merely unchecked', () => {
  // Most of the assessment's value. Both are unexcluded; only one is an errand.
  const assessment = assessAssumptionFragility(['a', 'b'], [
    countermodel({
      id: 'countermodel:permanent', violates: 'a', world: WORLD, claimBecomes: BECOMES,
      excludedBy: null, status: 'live',
    }),
    countermodel({
      id: 'countermodel:actionable', violates: 'b', world: WORLD, claimBecomes: BECOMES,
      excludedBy: 'fetching the report from the provider', status: 'live',
    }),
  ]);
  assert.deepEqual(assessment.live.map((item) => item.id), ['countermodel:permanent', 'countermodel:actionable']);
  assert.deepEqual(assessment.unexcludable.map((item) => item.id), ['countermodel:permanent']);
  assert.deepEqual([...assessment.fragileAssumptions], ['a', 'b']);
});

test('an established countermodel is stronger than an unexcluded one, and says so', () => {
  const assessment = assessAssumptionFragility(['a'], [countermodel({
    id: 'countermodel:realized', violates: 'a', world: WORLD, claimBecomes: BECOMES,
    excludedBy: null, status: 'realized',
  })]);
  assert.equal(assessment.claimHoldsAsStated, false, 'the claim does not hold as stated');
  assert.deepEqual([...assessment.violatedAssumptions], ['a']);
  assert.deepEqual([...assessment.fragileAssumptions], ['a'], 'a broken assumption is also a fragile one');
  assert.deepEqual(assessment.unexcludable.map((item) => item.id), ['countermodel:realized'],
    'an established world is by definition one nothing excluded');
});

// ---------------------------------------------------------------------------
// The reconciliation residual
// ---------------------------------------------------------------------------

test('every permanent condition of a reconciliation carries a world', () => {
  // The conditions list and the worlds are two enumerations of one thing. The
  // Record type catches a missing world at compile time; this catches the
  // reverse — a condition that stops producing one at runtime — and keeps the
  // assessment's `robustnessAssessed` meaningful rather than accidental.
  const models = reconciliationCountermodels(run());
  assert.deepEqual(
    models.map((item) => item.violates).sort(),
    [...PERMANENT_CONDITIONS].sort(),
  );
  const assessment = assessAssumptionFragility([...run().conditions], models);
  assert.equal(assessment.robustnessAssessed, true, 'every stated condition is examined');
  assert.deepEqual([...assessment.uncoveredAssumptions], []);
});

test('four of the residual’s conditions can be excluded by nothing Fiscus has', () => {
  // The finding, not a gap in the file: the residual is PERMANENTLY conditional.
  // An operator cannot work through this list and arrive at an unconditional
  // number, and the assessment has to be able to say that rather than leaving
  // them to discover it one check at a time.
  const assessment = assessAssumptionFragility([...run().conditions], reconciliationCountermodels(run()));
  assert.equal(assessment.unexcludable.length, 4);
  assert.equal(assessment.excluded.length, 0, 'a condition Fiscus could rule out would not survive as a condition');
  assert.equal(assessment.claimHoldsAsStated, true, 'conditional is not the same as broken');
  for (const model of assessment.unexcludable) {
    assert.equal(model.excludedBy, null);
    assert.ok(model.claimBecomes.length > 0, 'and each says what the residual degrades to');
  }
});

test('the operator-supplied condition names a discriminator, so it is an errand rather than a limit', () => {
  const supplied = run({
    providerSourceKind: 'operator_supplied_export',
    conditions: [...PERMANENT_CONDITIONS, 'provider_report_is_operator_supplied_and_unverified'],
  });
  const assessment = assessAssumptionFragility([...supplied.conditions], reconciliationCountermodels(supplied));
  assert.equal(assessment.live.length, 5);
  assert.equal(assessment.unexcludable.length, 4, 'the fifth is closable, so it is not a permanent condition');

  const closable = assessment.live.find((item) => item.violates === 'provider_report_is_operator_supplied_and_unverified');
  assert.ok(closable, 'the operator-supplied world is present when the report was operator-supplied');
  assert.match(closable.excludedBy ?? '', /fetching the report from the provider/i);

  // And it disappears entirely on a fetched run: there is no such assumption to
  // violate, so producing a world for it would assess a condition the claim does
  // not state.
  const fetched = reconciliationCountermodels(run());
  assert.equal(fetched.some((item) => item.violates === 'provider_report_is_operator_supplied_and_unverified'), false);
});

test('a negative residual does not leave the over-pricing world open — it establishes it', () => {
  // D-068 as a property of the claim's assumptions rather than a sentence
  // beneath the number. R < 0 means L > P >= T, which refutes `L <= T` outright.
  const negative = run({
    providerReportedMicros: 900_000,
    localCapturedMicros: 1_000_000,
    unexplainedVarianceMicros: -100_000,
    offPathBound: 'none_local_estimate_exceeds_provider',
  });
  const assessment = assessAssumptionFragility([...negative.conditions], reconciliationCountermodels(negative));

  assert.equal(assessment.claimHoldsAsStated, false, 'the residual no longer bounds what the claim says it bounds');
  assert.deepEqual([...assessment.violatedAssumptions], ['local_request_amounts_are_rate_card_estimates']);
  assert.equal(assessment.realized.length, 1);
  assert.equal(assessment.live.length, 3, 'the other three are unchanged and still merely live');

  // The contrast is the point: the same three conditions, a positive residual,
  // and nothing is established.
  const positive = assessAssumptionFragility([...run().conditions], reconciliationCountermodels(run()));
  assert.equal(positive.claimHoldsAsStated, true);
  assert.deepEqual([...positive.violatedAssumptions], []);
});

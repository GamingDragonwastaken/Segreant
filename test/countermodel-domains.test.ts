import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAssumptionFragility, countermodel } from '../src/epistemic/countermodel.ts';
import { reconciliationCountermodels } from '../src/billing/countermodels.ts';
import { PERMANENT_CONDITIONS, type ReconciliationRun } from '../src/billing/reconcile.ts';
import { certifyDecision, type ActionUtilityInterval } from '../src/decision/engine.ts';
import { decisionCountermodels } from '../src/decision/countermodels.ts';

function reconciliationRun(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  return {
    status: 'reconciled_with_residual',
    observationRunId: 'observation:countermodel',
    declaredScopeId: 'scope:countermodel',
    providerProjectRef: 'project-a',
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_086_400_000,
    currency: 'USD',
    materialityUsd: 0.5,
    providerReportedMicros: 1_334_567,
    localCapturedMicros: 1_000_000,
    unexplainedVarianceMicros: 334_567,
    coverage: {
      providerDays: 2,
      localDays: 2,
      daysWithBoth: 2,
      providerOnlyDays: 0,
      localOnlyDays: 0,
      materialDays: 1,
    },
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

const INTERVALS: readonly ActionUtilityInterval[] = [
  { action: 'ship', low: 4, high: 10 },
  { action: 'wait', low: 5, high: 11 },
];

test('certification is withheld when assumptions are uncovered or countermodels remain live', () => {
  const excluded = assessAssumptionFragility(['source is complete'], [countermodel({
    id: 'countermodel:excluded',
    violates: 'source is complete',
    world: 'the source omitted a billed line',
    claimBecomes: 'the total is a lower bound only',
    excludedBy: 'a complete source manifest',
    status: 'excluded',
  })]);
  assert.equal(excluded.robustnessAssessed, true);
  assert.equal(excluded.certified, true);

  const uncovered = assessAssumptionFragility(['source is complete', 'scope is joined'], []);
  assert.equal(uncovered.robustnessAssessed, false);
  assert.equal(uncovered.certified, false);

  const live = assessAssumptionFragility(['source is complete'], [countermodel({
    id: 'countermodel:live',
    violates: 'source is complete',
    world: 'the source omitted a billed line',
    claimBecomes: 'the total is a lower bound only',
    excludedBy: 'a complete source manifest',
    status: 'live',
  })]);
  assert.equal(live.robustnessAssessed, true);
  assert.equal(live.certified, false);
});

test('the economic reconciliation domain emits a complete, non-inflating witness set', () => {
  const run = reconciliationRun();
  const models = reconciliationCountermodels(run);
  const assessment = assessAssumptionFragility([...run.conditions], models);

  assert.deepEqual(models.map((model) => model.violates).sort(), [...run.conditions].sort());
  assert.equal(assessment.robustnessAssessed, true);
  assert.equal(assessment.certified, false);
  assert.equal(assessment.unexcludable.length, 4);
  assert.equal(assessment.realized.length, 0);

  const negative = reconciliationRun({
    providerReportedMicros: 900_000,
    localCapturedMicros: 1_000_000,
    unexplainedVarianceMicros: -100_000,
    offPathBound: 'none_local_estimate_exceeds_provider',
  });
  const negativeAssessment = assessAssumptionFragility(
    [...negative.conditions],
    reconciliationCountermodels(negative),
  );
  assert.equal(negativeAssessment.claimHoldsAsStated, false);
  assert.equal(negativeAssessment.certified, false);
  assert.equal(negativeAssessment.realized.length, 1);
});

test('the decision domain emits explicit witnesses when interval dominance is undetermined', () => {
  const certificate = certifyDecision(INTERVALS);
  const models = decisionCountermodels(INTERVALS);
  const assessment = assessAssumptionFragility([...certificate.assumptions], models);

  assert.equal(certificate.status, 'undetermined');
  assert.equal(models.length, certificate.assumptions.length);
  assert.equal(assessment.robustnessAssessed, true);
  assert.equal(assessment.certified, false);
  assert.equal(assessment.realized.length, 0);
  assert.ok(assessment.live.every((model) => model.excludedBy !== null));
  assert.ok(assessment.live.every((model) => model.claimBecomes.includes('not certified')));
});

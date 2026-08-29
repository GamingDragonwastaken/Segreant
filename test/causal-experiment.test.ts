import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePairedCausalExperiment,
  causalExperimentPlanHash,
  createPairedCausalExperiment,
  type CausalObservation,
} from '../src/value/causalExperiment.ts';

function plan() {
  return createPairedCausalExperiment({
    experimentId: 'trial-2026-08',
    createdAt: '2026-08-22T12:00:00.000Z',
    benefitBoundsUsd: { low: -100, high: 300 },
    confidenceLevel: 0.9,
    laborRatePerHour: 60,
    pairs: [
      { pairId: 'p1', stratum: 'bugfix', unitAId: 'p1-a', unitBId: 'p1-b' },
      { pairId: 'p2', stratum: 'bugfix', unitAId: 'p2-a', unitBId: 'p2-b' },
      { pairId: 'p3', stratum: 'feature', unitAId: 'p3-a', unitBId: 'p3-b' },
      { pairId: 'p4', stratum: 'feature', unitAId: 'p4-a', unitBId: 'p4-b' },
    ],
    randomizationMaterial: new Uint8Array([0b00000101]),
  });
}

function observationsFor(input = plan()): CausalObservation[] {
  const hash = causalExperimentPlanHash(input);
  return input.assignments.flatMap((assignment, index) => [
    {
      experimentId: input.experimentId,
      planHash: hash,
      pairId: assignment.pairId,
      unitId: assignment.aiUnitId,
      arm: 'ai' as const,
      outcomeValueUsd: 200,
      humanMinutes: 30,
      aiCostUsd: 10 + index,
    },
    {
      experimentId: input.experimentId,
      planHash: hash,
      pairId: assignment.pairId,
      unitId: assignment.controlUnitId,
      arm: 'control' as const,
      outcomeValueUsd: 150,
      humanMinutes: 90,
      aiCostUsd: 0,
    },
  ]);
}

test('a Fiscus-created plan replays its exact paired randomization and binds observations to its hash', () => {
  const created = plan();
  assert.equal(created.assignments[0]!.aiUnitId, 'p1-a');
  assert.equal(created.assignments[1]!.aiUnitId, 'p2-b');
  const result = analyzePairedCausalExperiment(created, observationsFor(created));
  assert.equal(result.ok, true);
  assert.equal(result.evidence.grade, 'operator_attested_randomized_paired_estimate');
  assert.equal(result.pairCount, 4);
  assert.match(result.planHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(result.incrementalAiCostUsd, 11.5);
  assert.ok((result.incrementalBenefitUsd?.point ?? 0) > 0);
});

test('a result cannot call break-even supported unless the conservative lower bound clears it', () => {
  const created = plan();
  const result = analyzePairedCausalExperiment(created, observationsFor(created));
  assert.equal(result.ok, true);
  assert.equal(result.evidence.breakEven, 'not_established', 'four bounded pairs leave a deliberately wide finite-sample interval');
  assert.ok((result.causalIncrementalReturn?.low ?? 1) < 1);
});

test('a plan or observation edit invalidates the local causal protocol rather than being silently accepted', () => {
  const created = plan();
  const tamperedPlan = { ...created, assignments: created.assignments.map((assignment) => ({ ...assignment })) };
  [tamperedPlan.assignments[0]!.aiUnitId, tamperedPlan.assignments[0]!.controlUnitId] = [tamperedPlan.assignments[0]!.controlUnitId, tamperedPlan.assignments[0]!.aiUnitId];
  const result = analyzePairedCausalExperiment(tamperedPlan, observationsFor(created));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /randomization material/i.test(error)));

  const mismatchedHash = observationsFor(created).map((observation) => ({ ...observation }));
  mismatchedHash[0]!.planHash = '0'.repeat(64);
  const hashResult = analyzePairedCausalExperiment(created, mismatchedHash);
  assert.equal(hashResult.ok, false);
  assert.ok(hashResult.errors.some((error) => /plan hash/i.test(error)));
});

test('missing pairs, non-zero control spend, out-of-bound benefits, and allocation swaps all fail closed', () => {
  const created = plan();
  const observations = observationsFor(created);

  const missing = analyzePairedCausalExperiment(created, observations.slice(0, -1));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => /exactly two observations/i.test(error)));

  const costlyControl = observations.map((observation) => ({ ...observation }));
  costlyControl.find((observation) => observation.arm === 'control')!.aiCostUsd = 0.01;
  const controlResult = analyzePairedCausalExperiment(created, costlyControl);
  assert.equal(controlResult.ok, false);
  assert.ok(controlResult.errors.some((error) => /no-AI control/i.test(error)));

  const unbounded = observations.map((observation) => ({ ...observation }));
  unbounded[0]!.outcomeValueUsd = 9_999;
  const boundsResult = analyzePairedCausalExperiment(created, unbounded);
  assert.equal(boundsResult.ok, false);
  assert.ok(boundsResult.errors.some((error) => /pre-registered benefit bounds/i.test(error)));

  const swapped = observations.map((observation) => ({ ...observation }));
  const ai = swapped.find((observation) => observation.arm === 'ai')!;
  ai.unitId = created.assignments[0]!.controlUnitId;
  const allocationResult = analyzePairedCausalExperiment(created, swapped);
  assert.equal(allocationResult.ok, false);
  assert.ok(allocationResult.errors.some((error) => /pre-specified allocation/i.test(error)));
});

test('ordinary malformed records have no causal result, never a zero or optimistic fallback', () => {
  const result = analyzePairedCausalExperiment({ version: 999 }, []);
  assert.equal(result.ok, false);
  assert.equal(result.evidence.grade, 'not_established');
  assert.equal(result.incrementalBenefitUsd, null);
  assert.equal(result.causalIncrementalReturn, null);
});

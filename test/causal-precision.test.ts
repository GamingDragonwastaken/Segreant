/**
 * Precision planning has one failure mode worth guarding above all others:
 * drifting away from the estimator it claims to describe. A planner that
 * projects a half-width the estimator would not produce is worse than no
 * planner, because a caller spends money on the projection. The first test here
 * therefore does not check a formula — it checks the projection against an
 * interval the estimator actually returned for the same n and the same alpha.
 *
 * The rest pins what the planner refuses to say. It is not a power calculation
 * and never becomes one: the Hoeffding half-width is fixed by the pre-declared
 * range, n and alpha alone, so it can tell you how wide the interval will be
 * without knowing anything about the effect — and for exactly that reason it
 * cannot tell you the probability that the interval will clear a threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatedCostQualityData } from './support/causalStudyFixture.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import {
  projectCausalPrecision,
  projectCausalStudyPrecision,
  requiredObservedDifference,
  sampleSizeForCausalPrecision,
} from '../src/causal/precision.ts';
import type { CausalInferencePlan } from '../src/causal/inference-ledger.ts';

const QUALITY_BOUNDS = { low: 0, high: 1 } as const;
const COST_BOUNDS = { low: 0, high: 100 } as const;

test('the projected half-width equals the half-width the estimator actually produces', () => {
  const data = repeatedCostQualityData(1, 0.9, 1, 99);
  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.qualification.state, 'qualified');

  const actAlpha = estimate.jointInference.endpointAlpha;
  const quality = projectCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    perArmCompletedUnits: 500,
    actAlpha,
  });
  const realized = (estimate.qualityEffect!.upper - estimate.qualityEffect!.lower) / 2;
  assert.ok(
    Math.abs(realized - quality.intervalHalfWidth) < 1e-12,
    `projection ${quality.intervalHalfWidth} does not match realized ${realized}`,
  );

  // The cost interval in this fixture runs into the pre-declared bound and is
  // clamped there, so the realized half-width is narrower than the projection.
  // That is the only direction the clamp can move it, and the projection is
  // therefore an upper bound on width rather than an optimistic one.
  const cost = projectCausalPrecision({
    outcomeBounds: COST_BOUNDS,
    perArmCompletedUnits: 500,
    actAlpha,
  });
  const realizedCost = (estimate.costEffectUsd!.upper - estimate.costEffectUsd!.lower) / 2;
  assert.equal(estimate.costEffectUsd!.lower, -(COST_BOUNDS.high - COST_BOUNDS.low));
  assert.ok(realizedCost < cost.intervalHalfWidth);
});

test('the sample size for a target precision is the smallest n that reaches it', () => {
  const target = 0.05;
  const plan = sampleSizeForCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    targetIntervalHalfWidth: target,
    actAlpha: 0.025,
  });

  assert.ok(Number.isSafeInteger(plan.perArmCompletedUnits));
  assert.ok(plan.achievedIntervalHalfWidth <= target);
  const oneFewer = projectCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    perArmCompletedUnits: plan.perArmCompletedUnits - 1,
    actAlpha: 0.025,
  });
  assert.ok(oneFewer.intervalHalfWidth > target, 'the returned n is not minimal');
});

test('halving the target half-width costs four times the units', () => {
  const wide = sampleSizeForCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    targetIntervalHalfWidth: 0.1,
    actAlpha: 0.025,
  });
  const narrow = sampleSizeForCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    targetIntervalHalfWidth: 0.05,
    actAlpha: 0.025,
  });
  assert.ok(Math.abs(narrow.exactPerArmUnits / wide.exactPerArmUnits - 4) < 1e-9);
});

test('the projection states that it is not a power calculation and offers no probability', () => {
  const projection = projectCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    perArmCompletedUnits: 500,
    actAlpha: 0.025,
  });
  assert.ok(projection.limitations.some((line) => /not a power calculation/i.test(line)));
  assert.ok(projection.limitations.some((line) => /completed, included/i.test(line)));
  assert.ok(projection.assumptions.some((line) => /pre-declared/i.test(line)));
  assert.ok(
    !/probab|power|detect/i.test(JSON.stringify(Object.keys(projection))),
    'the projection exposes no field that reads as a probability of success',
  );
});

test('the required observed difference is a necessary condition, stated in both rule directions', () => {
  const projection = projectCausalPrecision({
    outcomeBounds: QUALITY_BOUNDS,
    perArmCompletedUnits: 500,
    actAlpha: 0.025,
  });
  const nonInferiority = requiredObservedDifference(projection, { kind: 'non_inferiority', margin: 0.05 });
  assert.equal(nonInferiority.direction, 'at_least');
  assert.ok(Math.abs(nonInferiority.observedDifference - (projection.intervalHalfWidth - 0.05)) < 1e-12);
  assert.ok(nonInferiority.limitations.some((line) => /necessary/i.test(line)));

  const costProjection = projectCausalPrecision({
    outcomeBounds: COST_BOUNDS,
    perArmCompletedUnits: 500,
    actAlpha: 0.025,
  });
  const superiority = requiredObservedDifference(costProjection, { kind: 'superiority', threshold: 0 });
  assert.equal(superiority.direction, 'at_most');
  assert.ok(Math.abs(superiority.observedDifference + costProjection.intervalHalfWidth) < 1e-9);
});

test('a study projection uses the protocol bounds and the joint rule endpoint alpha', () => {
  const data = repeatedCostQualityData(1, 0.9, 1, 99);
  const estimate = estimateCausalStudy(data);
  const projection = projectCausalStudyPrecision({
    protocol: data.protocol,
    perArmCompletedUnits: 500,
  });

  assert.ok(Math.abs(projection.actAlpha - estimate.jointInference.endpointAlpha) < 1e-15);
  assert.equal(projection.alphaBasis, 'joint_inference_rule');
  assert.equal(projection.netBenefit, null);
  const realizedQuality = (estimate.qualityEffect!.upper - estimate.qualityEffect!.lower) / 2;
  assert.ok(Math.abs(projection.quality.intervalHalfWidth - realizedQuality) < 1e-12);
});

test('a pre-registered multi-look plan buys less precision from the same units', () => {
  const data = repeatedCostQualityData(1, 0.9, 1, 99);
  const plan: CausalInferencePlan = {
    declaredAtMs: 1_700_000_000_500,
    maxLooks: 5,
    endpointsPerLook: 2,
    sliceIds: ['slice:registered_population'],
    targetFamilywiseErrorRate: 0.05,
  };
  const single = projectCausalStudyPrecision({ protocol: data.protocol, perArmCompletedUnits: 500 });
  const planned = projectCausalStudyPrecision({ protocol: data.protocol, perArmCompletedUnits: 500, plan });

  assert.equal(planned.alphaBasis, 'pre_registered_plan');
  assert.ok(Math.abs(planned.actAlpha - 0.005) < 1e-12);
  assert.ok(planned.quality.intervalHalfWidth > single.quality.intervalHalfWidth);
  assert.ok(
    planned.limitations.some((line) => /5 look/i.test(line)),
    'the plan that widened the projection is named on it',
  );
});

test('the planner refuses inputs it cannot honestly answer', () => {
  assert.throws(
    () => projectCausalPrecision({ outcomeBounds: { low: 1, high: 1 }, perArmCompletedUnits: 10, actAlpha: 0.025 }),
    /range/i,
  );
  assert.throws(
    () => projectCausalPrecision({ outcomeBounds: QUALITY_BOUNDS, perArmCompletedUnits: 0, actAlpha: 0.025 }),
    /units/i,
  );
  assert.throws(
    () => projectCausalPrecision({ outcomeBounds: QUALITY_BOUNDS, perArmCompletedUnits: 10, actAlpha: 0 }),
    /alpha/i,
  );
  assert.throws(
    () => sampleSizeForCausalPrecision({
      outcomeBounds: QUALITY_BOUNDS,
      targetIntervalHalfWidth: 0,
      actAlpha: 0.025,
    }),
    /half-width/i,
  );
});

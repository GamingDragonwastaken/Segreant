/**
 * What a sample size buys, and what it costs to buy a target precision.
 *
 * A caller deciding whether to run another two hundred units through a study is
 * spending real money on evidence, and until now had no way to ask what that
 * money would buy except to run the study and look at the interval afterwards.
 * This module answers the question in advance, using the estimator's own
 * arithmetic rather than a second implementation of it — `hoeffdingArmRadius`
 * is imported from `estimate.ts` for exactly that reason, and a test pins the
 * projection against an interval the estimator actually returned.
 *
 * The honest half of this is the more important half. The Hoeffding half-width
 * depends on the pre-declared outcome range, the per-arm sample size and the
 * per-act alpha, and on NOTHING else — not on a variance, not on an assumed
 * effect, not on a pilot estimate. That makes the projection unusually solid:
 * it is the width the interval WILL have, not the width it will probably have.
 *
 * It also makes it strictly less than a power calculation, and this module
 * refuses to be mistaken for one. Whether the interval clears the registered
 * non-inferiority margin or cost-superiority threshold depends on where the
 * true effect sits, which is the thing the study exists to find out. Fiscus
 * will tell a caller the observed difference that would be REQUIRED at a given
 * n; it will not tell them the probability of observing it, because computing
 * that probability means assuming the answer.
 */

import { hoeffdingArmRadius, resolveCausalJointInference } from './estimate.ts';
import {
  plannedInferenceActs,
  requiredActAlphaForPlan,
  type CausalInferencePlan,
} from './inference-ledger.ts';
import type {
  CausalJointInferenceResult,
  CommittedCausalStudyProtocol,
  NumericBounds,
} from './types.ts';

export const CAUSAL_PRECISION_METHOD = 'hoeffding_union_bound_difference_in_means' as const;

export interface CausalPrecisionInput {
  outcomeBounds: NumericBounds;
  /** Completed, INCLUDED units per arm — not units assigned and not units enrolled. */
  perArmCompletedUnits: number;
  actAlpha: number;
}

export interface CausalPrecisionProjection {
  method: typeof CAUSAL_PRECISION_METHOD;
  outcomeRange: number;
  perArmCompletedUnits: number;
  actAlpha: number;
  actConfidenceLevel: number;
  armRadius: number;
  intervalHalfWidth: number;
  intervalWidth: number;
  assumptions: string[];
  limitations: string[];
}

export interface CausalSampleSizeInput {
  outcomeBounds: NumericBounds;
  targetIntervalHalfWidth: number;
  actAlpha: number;
}

export interface CausalSampleSizeProjection {
  method: typeof CAUSAL_PRECISION_METHOD;
  outcomeRange: number;
  actAlpha: number;
  actConfidenceLevel: number;
  targetIntervalHalfWidth: number;
  /** The real-valued requirement before rounding, so the quadratic cost is visible. */
  exactPerArmUnits: number;
  perArmCompletedUnits: number;
  achievedIntervalHalfWidth: number;
  assumptions: string[];
  limitations: string[];
}

export type CausalDecisionRule =
  | { kind: 'non_inferiority'; margin: number }
  | { kind: 'superiority'; threshold: number };

export interface CausalSeparationRequirement {
  rule: CausalDecisionRule;
  direction: 'at_least' | 'at_most';
  observedDifference: number;
  intervalHalfWidth: number;
  limitations: string[];
}

export interface CausalStudyPrecisionProjection {
  perArmCompletedUnits: number;
  actAlpha: number;
  alphaBasis: 'joint_inference_rule' | 'pre_registered_plan';
  jointInference: CausalJointInferenceResult;
  cost: CausalPrecisionProjection;
  quality: CausalPrecisionProjection;
  netBenefit: CausalPrecisionProjection | null;
  assumptions: string[];
  limitations: string[];
}

function outcomeRangeOf(bounds: NumericBounds): number {
  const range = bounds.high - bounds.low;
  if (!Number.isFinite(range) || range <= 0) {
    throw new Error('outcome bounds must declare a positive finite range; a precision projection without a pre-declared range would be a guess');
  }
  return range;
}

function assertSampleSize(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('perArmCompletedUnits must be a positive integer count of completed, included units per arm');
  }
}

function assertAlpha(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('actAlpha must be a finite per-act error rate in (0,1)');
  }
}

function projectionAssumptions(): string[] {
  return [
    'The half-width follows from the pre-declared outcome range, the per-arm completed unit count, and the per-act alpha alone; no variance, pilot estimate, or assumed effect enters it.',
    'Both arms are assumed to reach the same completed, included unit count; unequal arms widen the interval by the larger arm-radius sum, never by less.',
    'The per-act alpha is assumed to be the one the estimator will actually apply, which is the registered joint rule endpoint alpha unless a pre-registered inference plan reduces it.',
  ];
}

function projectionLimitations(): string[] {
  return [
    'This is not a power calculation and does not become one. It states the width the interval will have, not the probability that the interval will support a decision — that depends on the true effect, which is what the study exists to measure.',
    'The unit count is completed, included units per arm after exclusions and missingness. Assignments do not become completed units, and a study that plans against assignments will land wider than this projection.',
    'A Hoeffding interval is deliberately conservative: it buys distribution-freedom with width, so a narrower interval is reachable only by a method that assumes more than the registered protocol does.',
    'The projection prices precision in units of evidence. It does not price the units themselves; what a unit costs to acquire is metered usage and provider billing, which are separate claims with their own evidence.',
  ];
}

/**
 * The half-width the estimator will produce for this range, n and alpha. The
 * estimator additionally clamps its interval to the pre-declared range, which
 * can only make the reported interval narrower than this projection — so the
 * projection is an upper bound on the width, never an optimistic one.
 */
export function projectCausalPrecision(input: CausalPrecisionInput): CausalPrecisionProjection {
  const outcomeRange = outcomeRangeOf(input.outcomeBounds);
  assertSampleSize(input.perArmCompletedUnits);
  assertAlpha(input.actAlpha);
  const armRadius = hoeffdingArmRadius(outcomeRange, input.perArmCompletedUnits, input.actAlpha);
  const intervalHalfWidth = armRadius * 2;
  return Object.freeze({
    method: CAUSAL_PRECISION_METHOD,
    outcomeRange,
    perArmCompletedUnits: input.perArmCompletedUnits,
    actAlpha: input.actAlpha,
    actConfidenceLevel: 1 - input.actAlpha,
    armRadius,
    intervalHalfWidth,
    intervalWidth: intervalHalfWidth * 2,
    assumptions: projectionAssumptions(),
    limitations: projectionLimitations(),
  });
}

/**
 * Invert the same expression: `h = range * sqrt(2 * ln(4/alpha) / n)` gives
 * `n = 2 * ln(4/alpha) * range^2 / h^2`. Precision costs quadratically, and
 * `exactPerArmUnits` is returned unrounded so a caller can see that halving the
 * target half-width quadruples the evidence they have to buy.
 */
export function sampleSizeForCausalPrecision(input: CausalSampleSizeInput): CausalSampleSizeProjection {
  const outcomeRange = outcomeRangeOf(input.outcomeBounds);
  assertAlpha(input.actAlpha);
  if (typeof input.targetIntervalHalfWidth !== 'number'
      || !Number.isFinite(input.targetIntervalHalfWidth)
      || input.targetIntervalHalfWidth <= 0) {
    throw new Error('targetIntervalHalfWidth must be a positive finite half-width in outcome units');
  }
  const exactPerArmUnits = 2 * Math.log(4 / input.actAlpha) * outcomeRange * outcomeRange
    / (input.targetIntervalHalfWidth * input.targetIntervalHalfWidth);
  if (!Number.isFinite(exactPerArmUnits) || exactPerArmUnits > Number.MAX_SAFE_INTEGER) {
    throw new Error('the requested precision is not reachable at a representable sample size');
  }
  // The ceiling is recomputed rather than trusted: a planner that returns an n
  // which misses its own target has told the caller to spend money on a promise
  // it did not keep, and floating-point rounding at the boundary is enough to
  // do that once in a while.
  let perArmCompletedUnits = Math.max(1, Math.ceil(exactPerArmUnits));
  let achieved = projectCausalPrecision({
    outcomeBounds: input.outcomeBounds,
    perArmCompletedUnits,
    actAlpha: input.actAlpha,
  }).intervalHalfWidth;
  while (achieved > input.targetIntervalHalfWidth) {
    perArmCompletedUnits += 1;
    achieved = projectCausalPrecision({
      outcomeBounds: input.outcomeBounds,
      perArmCompletedUnits,
      actAlpha: input.actAlpha,
    }).intervalHalfWidth;
  }
  return Object.freeze({
    method: CAUSAL_PRECISION_METHOD,
    outcomeRange,
    actAlpha: input.actAlpha,
    actConfidenceLevel: 1 - input.actAlpha,
    targetIntervalHalfWidth: input.targetIntervalHalfWidth,
    exactPerArmUnits,
    perArmCompletedUnits,
    achievedIntervalHalfWidth: achieved,
    assumptions: projectionAssumptions(),
    limitations: projectionLimitations(),
  });
}

/**
 * The observed difference a decision rule would require at this precision.
 *
 * Non-inferiority passes when `estimate - h > -margin`, superiority when
 * `estimate + h < -threshold`, so each rule implies one boundary on the
 * observed difference. Whether the study lands on the right side of it is a
 * fact about the world; this is the necessary condition, not a forecast.
 */
export function requiredObservedDifference(
  projection: CausalPrecisionProjection,
  rule: CausalDecisionRule,
): CausalSeparationRequirement {
  const limitations = [
    'This is a necessary condition on the observed difference, not a probability that it will be met and not a prediction of the result.',
    'It is computed at the projected half-width; a study that completes fewer included units than projected requires a larger separation than this.',
  ];
  if (rule.kind === 'non_inferiority') {
    return Object.freeze({
      rule,
      direction: 'at_least',
      observedDifference: projection.intervalHalfWidth - rule.margin,
      intervalHalfWidth: projection.intervalHalfWidth,
      limitations,
    });
  }
  return Object.freeze({
    rule,
    direction: 'at_most',
    observedDifference: -(projection.intervalHalfWidth + rule.threshold),
    intervalHalfWidth: projection.intervalHalfWidth,
    limitations,
  });
}

/**
 * Project every registered endpoint of one committed protocol at once, at the
 * alpha the estimator will actually use. Passing a pre-registered inference
 * plan reduces that alpha to what the plan can afford across all its looks,
 * which is the point: planning for ten looks and then planning precision as
 * though there would be one is how a study gets funded for evidence it will not
 * be able to report at the level it promised.
 */
export function projectCausalStudyPrecision(input: {
  protocol: CommittedCausalStudyProtocol;
  perArmCompletedUnits: number;
  plan?: CausalInferencePlan | null;
}): CausalStudyPrecisionProjection {
  const jointInference = resolveCausalJointInference(input.protocol);
  const plan = input.plan ?? null;
  const actAlpha = plan === null ? jointInference.endpointAlpha : requiredActAlphaForPlan(plan);
  const alphaBasis = plan === null ? 'joint_inference_rule' : 'pre_registered_plan';
  const project = (bounds: NumericBounds): CausalPrecisionProjection => projectCausalPrecision({
    outcomeBounds: bounds,
    perArmCompletedUnits: input.perArmCompletedUnits,
    actAlpha,
  });
  const economic = input.protocol.economicOutcome;
  return Object.freeze({
    perArmCompletedUnits: input.perArmCompletedUnits,
    actAlpha,
    alphaBasis,
    jointInference,
    cost: project(input.protocol.costOutcome.boundsUsd),
    quality: project(input.protocol.qualityOutcome.bounds),
    // The net-benefit range is the economic range minus the full-cost range,
    // matching the bounds the estimator derives for the same endpoint.
    netBenefit: economic === null ? null : project({
      low: economic.boundsUsd.low - input.protocol.costOutcome.boundsUsd.high,
      high: economic.boundsUsd.high - input.protocol.costOutcome.boundsUsd.low,
    }),
    assumptions: projectionAssumptions(),
    limitations: [
      ...projectionLimitations(),
      plan === null
        ? `The per-act alpha is the registered joint rule's endpoint alpha (${jointInference.endpointCount} ${jointInference.endpointFamily} endpoint(s) at ${((1 - jointInference.endpointAlpha) * 100).toFixed(4)}% each). It covers one look; a second look is not priced here.`
        : `The projection is widened for a pre-registered plan of ${plan.maxLooks} look(s) x ${plan.endpointsPerLook} endpoint(s) x ${plan.sliceIds.length} slice(s) = ${plannedInferenceActs(plan)} act(s) at family-wise ${(plan.targetFamilywiseErrorRate * 100).toFixed(4)}%, so each act is projected at ${((1 - actAlpha) * 100).toFixed(4)}%.`,
    ],
  });
}

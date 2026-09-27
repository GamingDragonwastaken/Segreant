/**
 * ISSUANCE CLASS: kernel_primitive — see `src/epistemic/issuance-map.ts`.
 * Depends on `qualification.ts` and inherits its position. The estimator
 * pre-declares its bounds and does not adapt; `src/causal/epistemic.ts` carries
 * the interval and the joint decision rule onto an issued Claim, so revoking the
 * study evidence invalidates what was derived from it. This file still decides
 * whether an effect is supported — issuance refuses to mint a causal claim it
 * did not already authorise, and adds revocability rather than strength.
 *
 * Conservative, transparent estimators for the initial randomized-study lane.
 *
 * The first version deliberately avoids adaptive modelling and p-value badges.
 * It reports a simple assigned-arm difference with finite-range Hoeffding
 * intervals whose bounds were declared before outcome collection.
 */

import { qualifyCausalStudy } from './qualification.ts';
import { resolveEstimandDefinition } from './estimand.ts';
import { resolveCausalDesignEstimator } from './registry.ts';
import type {
  ArmCounts,
  CausalEffectInterval,
  CausalStudyData,
  CausalStudyEstimate,
  CausalJointInferenceResult,
  CommittedCausalStudyProtocol,
  NumericBounds,
} from './types.ts';

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One arm's half-width under the union-bound Hoeffding construction. This was
 * inline arithmetic in `boundedDifference` until `precision.ts` needed to tell a
 * caller what a given sample size would buy BEFORE the money was spent
 * acquiring it. A planner that reimplements the estimator's formula is a
 * planner that will one day quietly disagree with it, so both callers share
 * this expression and a test pins the projection against a realized interval.
 */
export function hoeffdingArmRadius(outcomeRange: number, sampleSize: number, alpha: number): number {
  return outcomeRange * Math.sqrt(Math.log(4 / alpha) / (2 * sampleSize));
}

/**
 * Difference in means for treatment minus control. A union-bound Hoeffding
 * interval requires only the predeclared finite range; it does not fit a
 * favourable empirical variance after outcomes are observed.
 */
function boundedDifference(
  treatment: number[][],
  control: number[][],
  bounds: NumericBounds,
  confidenceLevel: number,
): CausalEffectInterval {
  const treatmentCount = treatment.reduce((sum, block) => sum + block.length, 0);
  const controlCount = control.reduce((sum, block) => sum + block.length, 0);
  const total = treatmentCount + controlCount;
  const estimate = treatment.reduce((sum, block, index) => {
    const other = control[index]!;
    return sum + (block.length + other.length) * (mean(block) - mean(other));
  }, 0) / total;
  const alpha = 1 - confidenceLevel;
  const width = bounds.high - bounds.low;
  const radius = hoeffdingArmRadius(width, treatmentCount, alpha)
    + hoeffdingArmRadius(width, controlCount, alpha);
  return {
    estimate,
    lower: Math.max(-width, estimate - radius),
    upper: Math.min(width, estimate + radius),
  };
}

function standardLimitations(): string[] {
  return [
    'This is a scoped local ITT estimate for the registered eligible population and study period, not a future-performance guarantee.',
    'Segreant validates retained protocol, assignment, execution, outcome, and arithmetic lineage locally; it is not an independent audit or provider-invoice certification.',
    'The result depends on valid randomized assignment, no interference, outcome completeness, and measurement assumptions; adherence is not required for ITT.',
    'ITT is primary: observed noncompliance stays in the assigned arm. Per-protocol and CACE/LATE effects are not estimated or identified by this result.',
    'Interference between units is not assessed by this estimator; the declared no-interference assumption is not an established absence of cross-unit effects.',
  ];
}

function missingnessLimitations(countsByArm: Record<string, ArmCounts>): string[] {
  const lines = ['Missingness counts use retained assignments that passed decision validation and qualifying execution/outcome pairs; rejected records and unretained assignments are not evidence of population completeness.'];
  for (const [armId, count] of Object.entries(countsByArm)) {
    if (count.assigned === 0) {
      lines.push('Arm ' + armId + ': missingness rate is unknown with zero assigned units counted by qualification, not a zero rate.');
      continue;
    }
    const missing = count.assigned - count.completed;
    lines.push('Arm ' + armId + ': ' + missing + '/' + count.assigned + ' retained validated assignments have unavailable qualifying execution/outcome pairs; this includes absent, pending, or rejected evidence, not confirmed attrition.');
  }
  lines.push('Attrition is unknown and the missingness mechanism is unknown; no imputation, reweighting, or complete-case re-analysis is applied. Incomplete qualifying pairs withhold an estimate rather than shrinking the assigned denominator.');
  return lines;
}

/**
 * The rule the estimator will apply, resolved from the protocol alone. It takes
 * the protocol rather than the study data because precision planning has to ask
 * the same question before any outcome exists — the endpoint alpha a caller must
 * plan against is a property of what was registered, not of what was collected.
 */
export function resolveCausalJointInference(
  protocol: CommittedCausalStudyProtocol,
): CausalJointInferenceResult {
  const declared = protocol.analysis.jointInference;
  const defaultFamily = protocol.question === 'model_cost_quality' ? 'cost_quality' : 'net_benefit';
  const defaultCount = defaultFamily === 'cost_quality' ? 2 : 1;
  const declaredMargin = protocol.qualityOutcome?.nonInferiorityMargin;
  const defaultMargin = Number.isFinite(declaredMargin) && declaredMargin >= 0 ? declaredMargin : 0;
  const declaredIsValid = declared !== undefined
    && declared.method === 'bonferroni'
    && declared.endpointFamily === defaultFamily
    && declared.endpointCount === defaultCount
    && declared.alphaAllocation === 'equal'
    && Number.isFinite(declared.nonInferiorityMargin)
    && declared.nonInferiorityMargin === defaultMargin
    && Number.isFinite(declared.costSuperiorityThresholdUsd)
    && declared.costSuperiorityThresholdUsd >= 0
    && (declared.secondaryEndpointPolicy === 'none' || declared.secondaryEndpointPolicy === 'descriptive_only');
  const endpointFamily = declaredIsValid ? declared.endpointFamily : defaultFamily;
  const endpointCount = declaredIsValid ? declared.endpointCount : defaultCount;
  const rawConfidence = protocol.analysis.confidenceLevel;
  const overallConfidenceLevel = Number.isFinite(rawConfidence) && rawConfidence > 0 && rawConfidence < 1 ? rawConfidence : 0.95;
  const endpointAlpha = (1 - overallConfidenceLevel) / endpointCount;
  return Object.freeze({
    method: 'bonferroni',
    endpointFamily,
    endpointCount,
    alphaAllocation: 'equal',
    nonInferiorityMargin: declaredIsValid ? declared.nonInferiorityMargin : defaultMargin,
    costSuperiorityThresholdUsd: declaredIsValid ? declared.costSuperiorityThresholdUsd : 0,
    secondaryEndpointPolicy: declaredIsValid ? declared.secondaryEndpointPolicy : 'none',
    overallConfidenceLevel,
    endpointConfidenceLevel: 1 - endpointAlpha,
    endpointAlpha,
    ruleSource: declaredIsValid ? 'protocol' : 'version_default',
  });
}

/**
 * Estimate only after all structural qualification gates have passed. A
 * randomized design can be valid yet inconclusive: interval evidence must pass
 * the predeclared decision rule before Segreant authorises claim language.
 */
export function estimateCausalStudy(data: CausalStudyData): CausalStudyEstimate {
  const qualification = qualifyCausalStudy(data);
  const jointInference = resolveCausalJointInference(data.protocol);
  const designEstimator = resolveCausalDesignEstimator(data.protocol);
  const estimandDefinition = designEstimator !== undefined
    ? resolveEstimandDefinition((data.protocol.analysis as unknown as { estimand?: unknown }).estimand) ?? null
    : null;
  const noEstimate: CausalStudyEstimate = {
    qualification,
    protocolHash: data.protocol.protocolHash,
    estimandId: estimandDefinition?.id ?? null,
    estimandDefinition,
    designEstimatorId: designEstimator?.id ?? null,
    costEffectUsd: null,
    qualityEffect: null,
    netBenefitEffectUsd: null,
    qualityNonInferiorityPassed: null,
    lowerCostPassed: null,
    causalNetBenefitSupported: null,
    jointInference,
    allowedClaim: 'not_established',
    limitations: [
      ...standardLimitations(),
      `Recorded noncompliance: ${data.executions.filter((execution) => execution.adherence === 'deviated').length} execution record(s); inclusion still requires valid lineage and complete observed cost/outcome evidence.`,
      ...missingnessLimitations(qualification.countsByArm),
      ...(estimandDefinition === null
        ? ['The protocol does not name a registered causal estimand; no estimand identity is inferred.']
        : []),
      `${jointInference.method} joint rule: ${(jointInference.overallConfidenceLevel * 100).toFixed(2)}% overall confidence allocated equally across ${jointInference.endpointCount} ${jointInference.endpointFamily} endpoint(s) at ${(jointInference.endpointConfidenceLevel * 100).toFixed(2)}% each; quality non-inferiority margin ${jointInference.nonInferiorityMargin}; cost superiority threshold $${jointInference.costSuperiorityThresholdUsd.toFixed(6)}; secondary endpoints ${jointInference.secondaryEndpointPolicy}${jointInference.ruleSource === 'version_default' ? ' (legacy protocol version default)' : ' (pre-registered in the protocol)'}.`,
    ],
  };
  if (qualification.state !== 'qualified' || designEstimator === undefined) return noEstimate;

  const { protocol } = data;
  const treatmentArm = protocol.question === 'model_cost_quality'
    ? protocol.arms.find((arm) => arm.role === 'candidate')!
    : protocol.arms.find((arm) => arm.role === 'ai')!;
  const controlArm = protocol.question === 'model_cost_quality'
    ? protocol.arms.find((arm) => arm.role === 'control')!
    : protocol.arms.find((arm) => arm.role === 'incumbent' || arm.role === 'no_ai')!;

  const decisions = new Map(data.decisions.map((decision) => [decision.decisionId, decision]));
  const executions = new Map(data.executions.map((execution) => [execution.decisionId, execution]));
  const outcomes = new Map(data.outcomes.map((outcome) => [outcome.decisionId, outcome]));

  const blockIds = [...new Set(data.decisions.map((decision) => decision.randomizationBlockId))].sort();
  const blockIndex = new Map(blockIds.map((id, index) => [id, index]));
  const treatmentCost: number[][] = blockIds.map(() => []);
  const controlCost: number[][] = blockIds.map(() => []);
  const treatmentQuality: number[][] = blockIds.map(() => []);
  const controlQuality: number[][] = blockIds.map(() => []);
  const treatmentNetBenefit: number[][] = blockIds.map(() => []);
  const controlNetBenefit: number[][] = blockIds.map(() => []);
  noEstimate.limitations.push(`${blockIds.length} complete balanced randomization block(s); assignment-count-weighted within-block contrasts, with conservative union-bound Hoeffding arm radii. Under the registered equal allocation these radii equal the pooled per-arm radii; no post-hoc variance reduction is claimed.`);
  noEstimate.limitations.push('Inference conditions on fixed eligible units and bounded potential outcomes, with uniform randomization within each block, independent randomization across blocks, and no interference. Retained blocks that are incomplete or unbalanced withhold the entire estimate; a whole block that was never retained is enrollment coverage, which lineage cannot establish here.');
  for (const decisionId of qualification.includedDecisionIds) {
    const decision = decisions.get(decisionId)!;
    const execution = executions.get(decisionId)!;
    const outcome = outcomes.get(decisionId)!;
    const index = blockIndex.get(decision.randomizationBlockId)!;
    const isTreatment = decision.assignedArmId === treatmentArm.armId;
    const cost = execution.directAiCostUsd!;
    const quality = outcome.qualityValue!;
    if (isTreatment) {
      treatmentCost[index]!.push(cost);
      treatmentQuality[index]!.push(quality);
      if (protocol.question === 'ai_vs_incumbent_net_benefit') {
        treatmentNetBenefit[index]!.push(outcome.economicValueUsd! - execution.fullArmCostUsd!);
      }
    } else if (decision.assignedArmId === controlArm.armId) {
      controlCost[index]!.push(cost);
      controlQuality[index]!.push(quality);
      if (protocol.question === 'ai_vs_incumbent_net_benefit') {
        controlNetBenefit[index]!.push(outcome.economicValueUsd! - execution.fullArmCostUsd!);
      }
    }
  }

  const costEffectUsd = boundedDifference(
    treatmentCost,
    controlCost,
    protocol.costOutcome.boundsUsd,
    jointInference.endpointConfidenceLevel,
  );
  const qualityEffect = boundedDifference(
    treatmentQuality,
    controlQuality,
    protocol.qualityOutcome.bounds,
    jointInference.endpointConfidenceLevel,
  );
  const qualityNonInferiorityPassed = qualityEffect.lower > -jointInference.nonInferiorityMargin;
  const lowerCostPassed = costEffectUsd.upper < -jointInference.costSuperiorityThresholdUsd;

  if (protocol.question === 'model_cost_quality') {
    return {
      ...noEstimate,
      costEffectUsd,
      qualityEffect,
      qualityNonInferiorityPassed,
      lowerCostPassed,
      causalNetBenefitSupported: null,
      allowedClaim: lowerCostPassed && qualityNonInferiorityPassed
        ? 'comparative_cost_quality_supported'
        : 'not_established',
    };
  }

  const economicBounds = protocol.economicOutcome!.boundsUsd;
  const fullCostBounds = protocol.costOutcome.boundsUsd;
  const netBounds = {
    low: economicBounds.low - fullCostBounds.high,
    high: economicBounds.high - fullCostBounds.low,
  };
  const netBenefitEffectUsd = boundedDifference(
    treatmentNetBenefit,
    controlNetBenefit,
    netBounds,
    jointInference.endpointConfidenceLevel,
  );
  const causalNetBenefitSupported = netBenefitEffectUsd.lower > 0;
  return {
    ...noEstimate,
    costEffectUsd,
    qualityEffect,
    netBenefitEffectUsd,
    qualityNonInferiorityPassed,
    lowerCostPassed,
    causalNetBenefitSupported,
    allowedClaim: causalNetBenefitSupported
      ? 'causal_net_benefit_supported'
      : 'not_established',
  };
}

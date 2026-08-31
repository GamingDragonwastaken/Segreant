/**
 * Conservative, transparent estimators for the initial randomized-study lane.
 *
 * The first version deliberately avoids adaptive modelling and p-value badges.
 * It reports a simple assigned-arm difference with finite-range Hoeffding
 * intervals whose bounds were declared before outcome collection.
 */

import { qualifyCausalStudy } from './qualification.ts';
import type {
  CausalEffectInterval,
  CausalStudyData,
  CausalStudyEstimate,
  CausalJointInferenceResult,
  NumericBounds,
} from './types.ts';

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Difference in means for treatment minus control. A union-bound Hoeffding
 * interval requires only the predeclared finite range; it does not fit a
 * favourable empirical variance after outcomes are observed.
 */
function boundedDifference(
  treatment: number[],
  control: number[],
  bounds: NumericBounds,
  confidenceLevel: number,
): CausalEffectInterval {
  const estimate = mean(treatment) - mean(control);
  const alpha = 1 - confidenceLevel;
  const width = bounds.high - bounds.low;
  const treatmentRadius = width * Math.sqrt(Math.log(4 / alpha) / (2 * treatment.length));
  const controlRadius = width * Math.sqrt(Math.log(4 / alpha) / (2 * control.length));
  const radius = treatmentRadius + controlRadius;
  return {
    estimate,
    lower: Math.max(-width, estimate - radius),
    upper: Math.min(width, estimate + radius),
  };
}

function standardLimitations(): string[] {
  return [
    'This is a scoped local ITT estimate for the registered eligible population and study period, not a future-performance guarantee.',
    'Fiscus validates retained protocol, assignment, execution, outcome, and arithmetic lineage locally; it is not an independent audit or provider-invoice certification.',
    'The result depends on the declared no-interference, outcome-completeness, assignment-following, and measurement assumptions.',
  ];
}

function jointInferenceRule(data: CausalStudyData): CausalJointInferenceResult {
  const declared = data.protocol.analysis.jointInference;
  const defaultFamily = data.protocol.question === 'model_cost_quality' ? 'cost_quality' : 'net_benefit';
  const defaultCount = defaultFamily === 'cost_quality' ? 2 : 1;
  const declaredMargin = data.protocol.qualityOutcome?.nonInferiorityMargin;
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
  const rawConfidence = data.protocol.analysis.confidenceLevel;
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
 * the predeclared decision rule before Fiscus authorises claim language.
 */
export function estimateCausalStudy(data: CausalStudyData): CausalStudyEstimate {
  const qualification = qualifyCausalStudy(data);
  const jointInference = jointInferenceRule(data);
  const noEstimate: CausalStudyEstimate = {
    qualification,
    protocolHash: data.protocol.protocolHash,
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
      `${jointInference.method} joint rule: ${(jointInference.overallConfidenceLevel * 100).toFixed(2)}% overall confidence allocated equally across ${jointInference.endpointCount} ${jointInference.endpointFamily} endpoint(s) at ${(jointInference.endpointConfidenceLevel * 100).toFixed(2)}% each; quality non-inferiority margin ${jointInference.nonInferiorityMargin}; cost superiority threshold $${jointInference.costSuperiorityThresholdUsd.toFixed(6)}; secondary endpoints ${jointInference.secondaryEndpointPolicy}${jointInference.ruleSource === 'version_default' ? ' (legacy protocol version default)' : ' (pre-registered in the protocol)'}.`,
    ],
  };
  if (qualification.state !== 'qualified') return noEstimate;

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

  const treatmentCost: number[] = [];
  const controlCost: number[] = [];
  const treatmentQuality: number[] = [];
  const controlQuality: number[] = [];
  const treatmentNetBenefit: number[] = [];
  const controlNetBenefit: number[] = [];
  for (const decisionId of qualification.includedDecisionIds) {
    const decision = decisions.get(decisionId)!;
    const execution = executions.get(decisionId)!;
    const outcome = outcomes.get(decisionId)!;
    const isTreatment = decision.assignedArmId === treatmentArm.armId;
    const cost = execution.directAiCostUsd!;
    const quality = outcome.qualityValue!;
    if (isTreatment) {
      treatmentCost.push(cost);
      treatmentQuality.push(quality);
      if (protocol.question === 'ai_vs_incumbent_net_benefit') {
        treatmentNetBenefit.push(outcome.economicValueUsd! - execution.fullArmCostUsd!);
      }
    } else if (decision.assignedArmId === controlArm.armId) {
      controlCost.push(cost);
      controlQuality.push(quality);
      if (protocol.question === 'ai_vs_incumbent_net_benefit') {
        controlNetBenefit.push(outcome.economicValueUsd! - execution.fullArmCostUsd!);
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

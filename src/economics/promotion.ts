export type PromotionStage = 'observe' | 'simulate' | 'recommend' | 'canary' | 'enforce';

export interface PromotionEvidence {
  lowerBoundNetImprovementMicros: number | null;
  qualityRegretUpper: number | null;
  maxQualityRegret: number;
  breachProbability: number | null;
  maxBreachProbability: number;
  independentSamples: number;
  minSamples: number;
  explorationBudgetMicros: number;
  driftAlarm: boolean;
  policyAllowed: boolean;
  /** Required only for canary -> enforce. */
  canarySamples?: number;
  minCanarySamples?: number;
}

export interface PromotionDecision {
  current: PromotionStage;
  nextEligible: PromotionStage;
  promotable: boolean;
  reasons: string[];
}

const NEXT: Record<PromotionStage, PromotionStage> = {
  observe: 'simulate',
  simulate: 'recommend',
  recommend: 'canary',
  canary: 'enforce',
  enforce: 'enforce',
};

function commonEvidenceReasons(evidence: PromotionEvidence): string[] {
  const reasons: string[] = [];
  if (!evidence.policyAllowed) reasons.push('policy does not permit this candidate');
  if (!Number.isSafeInteger(evidence.independentSamples) || evidence.independentSamples < 0) reasons.push('independentSamples is invalid');
  if (!Number.isSafeInteger(evidence.minSamples) || evidence.minSamples < 1) reasons.push('minSamples is invalid');
  if (evidence.independentSamples < evidence.minSamples) reasons.push(`only ${evidence.independentSamples} independent sample(s); need ${evidence.minSamples}`);
  if (evidence.driftAlarm) reasons.push('distribution drift is active');
  return reasons;
}

function decisionEvidenceReasons(evidence: PromotionEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.lowerBoundNetImprovementMicros === null || !Number.isFinite(evidence.lowerBoundNetImprovementMicros)) {
    reasons.push('lower-bound net improvement is unknown');
  } else if (evidence.lowerBoundNetImprovementMicros < 0) {
    reasons.push('lower-bound net improvement is negative');
  }

  if (!Number.isFinite(evidence.maxQualityRegret) || evidence.maxQualityRegret < 0) {
    reasons.push('maxQualityRegret is invalid');
  } else if (evidence.qualityRegretUpper === null || !Number.isFinite(evidence.qualityRegretUpper)) {
    reasons.push('quality-regret upper bound is unknown');
  } else if (evidence.qualityRegretUpper > evidence.maxQualityRegret) {
    reasons.push('quality-regret upper bound exceeds tolerance');
  }

  if (!Number.isFinite(evidence.maxBreachProbability) || evidence.maxBreachProbability < 0 || evidence.maxBreachProbability > 1) {
    reasons.push('maxBreachProbability is invalid');
  } else if (evidence.breachProbability === null || !Number.isFinite(evidence.breachProbability)) {
    reasons.push('budget-breach probability is unknown');
  } else if (evidence.breachProbability < 0 || evidence.breachProbability > 1) {
    reasons.push('budget-breach probability is invalid');
  } else if (evidence.breachProbability > evidence.maxBreachProbability) {
    reasons.push('budget-breach probability exceeds tolerance');
  }
  return reasons;
}

/**
 * Evidence gate for advancing AT MOST ONE stage. This function never mutates a
 * policy, never routes a request, and never treats an eligible transition as an
 * automatic transition.
 */
export function promotionDecision(current: PromotionStage, evidence: PromotionEvidence): PromotionDecision {
  if (current === 'enforce') return { current, nextEligible: current, promotable: false, reasons: ['already at enforce; no automatic transition exists'] };

  const reasons = commonEvidenceReasons(evidence);
  if (current !== 'observe') reasons.push(...decisionEvidenceReasons(evidence));

  if (current === 'recommend') {
    if (!Number.isSafeInteger(evidence.explorationBudgetMicros) || evidence.explorationBudgetMicros <= 0) {
      reasons.push('no explicit positive exploration budget is available for a canary');
    }
  }

  if (current === 'canary') {
    const minCanarySamples = evidence.minCanarySamples ?? evidence.minSamples;
    const canarySamples = evidence.canarySamples ?? 0;
    if (!Number.isSafeInteger(minCanarySamples) || minCanarySamples < 1) reasons.push('minCanarySamples is invalid');
    else if (!Number.isSafeInteger(canarySamples) || canarySamples < minCanarySamples) {
      reasons.push(`only ${canarySamples} canary sample(s); need ${minCanarySamples}`);
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    current,
    nextEligible: uniqueReasons.length === 0 ? NEXT[current] : current,
    promotable: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

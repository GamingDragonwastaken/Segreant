export interface LoggedPolicyOutcome {
  reward: number;
  /** Probability assigned by the behavior/logging policy to the action taken. */
  behaviorProbability: number;
  /** Probability the candidate target policy would assign to that same action. */
  targetProbability: number;
  /** Optional outcome-model estimate for the action that was actually taken. */
  directObservedAction?: number;
  /** Optional outcome-model expectation under the target policy for this context. */
  directTargetPolicy?: number;
}

export interface OffPolicyEstimate {
  method: 'snips' | 'doubly_robust';
  estimate: number | null;
  sampleCount: number;
  effectiveSampleSize: number | null;
  maxImportanceWeight: number | null;
  clippedWeights: number;
  supportAssumption: 'operator_asserted_overlap';
  assumptions: string[];
}

function checkedWeight(row: LoggedPolicyOutcome, index: number, maxWeight: number): { raw: number; used: number; clipped: boolean } {
  if (!Number.isFinite(row.reward)) throw new Error(`row ${index} reward must be finite`);
  if (!Number.isFinite(row.behaviorProbability) || row.behaviorProbability <= 0 || row.behaviorProbability > 1) {
    throw new Error(`row ${index} behaviorProbability must be in (0,1]`);
  }
  if (!Number.isFinite(row.targetProbability) || row.targetProbability < 0 || row.targetProbability > 1) {
    throw new Error(`row ${index} targetProbability must be in [0,1]`);
  }
  const raw = row.targetProbability / row.behaviorProbability;
  const used = Math.min(raw, maxWeight);
  return { raw, used, clipped: used < raw };
}

function diagnostics(weights: readonly number[]): { ess: number | null; maxWeight: number | null } {
  if (weights.length === 0) return { ess: null, maxWeight: null };
  const sum = weights.reduce((a, b) => a + b, 0);
  const sumSquares = weights.reduce((a, b) => a + b * b, 0);
  return {
    ess: sumSquares > 0 ? (sum * sum) / sumSquares : null,
    maxWeight: Math.max(...weights),
  };
}

/**
 * Self-normalized inverse-propensity estimate. Requires logged propensities and
 * an operator assertion that the behavior policy had support wherever the
 * target policy acts; a finite log alone cannot prove missing actions had
 * positive behavior probability.
 */
export function selfNormalizedIps(
  rows: readonly LoggedPolicyOutcome[],
  options: { maxWeight?: number; overlapAsserted?: boolean } = {},
): OffPolicyEstimate {
  const maxWeight = options.maxWeight ?? 20;
  if (!Number.isFinite(maxWeight) || maxWeight <= 0) throw new Error('maxWeight must be positive and finite');
  if (options.overlapAsserted !== true) {
    return {
      method: 'snips', estimate: null, sampleCount: rows.length, effectiveSampleSize: null,
      maxImportanceWeight: null, clippedWeights: 0, supportAssumption: 'operator_asserted_overlap',
      assumptions: ['overlap/common support has not been asserted; off-policy value is withheld'],
    };
  }

  const weights: number[] = [];
  let numerator = 0;
  let denominator = 0;
  let clippedWeights = 0;
  rows.forEach((row, index) => {
    const weight = checkedWeight(row, index, maxWeight);
    if (weight.clipped) clippedWeights += 1;
    weights.push(weight.used);
    numerator += weight.used * row.reward;
    denominator += weight.used;
  });
  const d = diagnostics(weights);
  return {
    method: 'snips',
    estimate: denominator > 0 ? numerator / denominator : null,
    sampleCount: rows.length,
    effectiveSampleSize: d.ess,
    maxImportanceWeight: d.maxWeight,
    clippedWeights,
    supportAssumption: 'operator_asserted_overlap',
    assumptions: [
      'logged propensities are correct',
      'contexts/actions satisfy common support for the target policy',
      ...(clippedWeights > 0 ? [`${clippedWeights} importance weight(s) clipped at ${maxWeight}`] : []),
    ],
  };
}

/**
 * Doubly robust estimator: model expectation under target policy plus an
 * importance-weighted residual correction on the action actually observed.
 */
export function doublyRobustEstimate(
  rows: readonly LoggedPolicyOutcome[],
  options: { maxWeight?: number; overlapAsserted?: boolean } = {},
): OffPolicyEstimate {
  const maxWeight = options.maxWeight ?? 20;
  if (!Number.isFinite(maxWeight) || maxWeight <= 0) throw new Error('maxWeight must be positive and finite');
  if (options.overlapAsserted !== true) {
    return {
      method: 'doubly_robust', estimate: null, sampleCount: rows.length, effectiveSampleSize: null,
      maxImportanceWeight: null, clippedWeights: 0, supportAssumption: 'operator_asserted_overlap',
      assumptions: ['overlap/common support has not been asserted; off-policy value is withheld'],
    };
  }
  if (rows.length === 0) {
    return {
      method: 'doubly_robust', estimate: null, sampleCount: 0, effectiveSampleSize: null,
      maxImportanceWeight: null, clippedWeights: 0, supportAssumption: 'operator_asserted_overlap',
      assumptions: ['no logged decisions'],
    };
  }

  const weights: number[] = [];
  let sum = 0;
  let clippedWeights = 0;
  rows.forEach((row, index) => {
    if (row.directObservedAction === undefined || row.directTargetPolicy === undefined ||
        !Number.isFinite(row.directObservedAction) || !Number.isFinite(row.directTargetPolicy)) {
      throw new Error(`row ${index} requires finite directObservedAction and directTargetPolicy estimates`);
    }
    const weight = checkedWeight(row, index, maxWeight);
    if (weight.clipped) clippedWeights += 1;
    weights.push(weight.used);
    sum += row.directTargetPolicy + weight.used * (row.reward - row.directObservedAction);
  });
  const d = diagnostics(weights);
  return {
    method: 'doubly_robust',
    estimate: sum / rows.length,
    sampleCount: rows.length,
    effectiveSampleSize: d.ess,
    maxImportanceWeight: d.maxWeight,
    clippedWeights,
    supportAssumption: 'operator_asserted_overlap',
    assumptions: [
      'logged propensities are correct or the supplied outcome model is correctly specified',
      'contexts/actions satisfy common support for the target policy',
      ...(clippedWeights > 0 ? [`${clippedWeights} importance weight(s) clipped at ${maxWeight}`] : []),
    ],
  };
}

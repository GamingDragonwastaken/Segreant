export interface BinaryPrediction {
  outcome: 0 | 1;
  probability: number;
}

export interface ComplexityCalibrationObservation {
  outcome: 0 | 1;
  baselineProbability: number;
  candidateProbability: number;
}

function validateProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be in [0,1]`);
}

export function brierScore(observations: readonly BinaryPrediction[]): number | null {
  if (observations.length === 0) return null;
  let sum = 0;
  for (const [index, observation] of observations.entries()) {
    validateProbability(observation.probability, `observation ${index} probability`);
    if (observation.outcome !== 0 && observation.outcome !== 1) throw new Error(`observation ${index} outcome must be 0 or 1`);
    const error = observation.probability - observation.outcome;
    sum += error * error;
  }
  return sum / observations.length;
}

/** Equal-width expected calibration error; diagnostic, not a proof of calibration. */
export function expectedCalibrationError(observations: readonly BinaryPrediction[], bins = 10): number | null {
  if (observations.length === 0) return null;
  if (!Number.isSafeInteger(bins) || bins < 2 || bins > 100) throw new Error('bins must be an integer in [2,100]');
  const bucketCounts = Array.from({ length: bins }, () => 0);
  const probabilitySums = Array.from({ length: bins }, () => 0);
  const outcomeSums = Array.from({ length: bins }, () => 0);

  for (const [index, observation] of observations.entries()) {
    validateProbability(observation.probability, `observation ${index} probability`);
    if (observation.outcome !== 0 && observation.outcome !== 1) throw new Error(`observation ${index} outcome must be 0 or 1`);
    const bucket = Math.min(bins - 1, Math.floor(observation.probability * bins));
    bucketCounts[bucket]! += 1;
    probabilitySums[bucket]! += observation.probability;
    outcomeSums[bucket]! += observation.outcome;
  }

  let ece = 0;
  for (let bucket = 0; bucket < bins; bucket += 1) {
    const count = bucketCounts[bucket]!;
    if (count === 0) continue;
    const meanProbability = probabilitySums[bucket]! / count;
    const meanOutcome = outcomeSums[bucket]! / count;
    ece += (count / observations.length) * Math.abs(meanProbability - meanOutcome);
  }
  return ece;
}

export interface CalibrationGateOptions {
  minSamples?: number;
  alpha?: number;
  minBrierImprovement?: number;
  maxEceRegression?: number;
  bins?: number;
}

export interface CalibrationGateResult {
  sampleCount: number;
  baselineBrier: number | null;
  candidateBrier: number | null;
  brierImprovement: number | null;
  pairedCandidateMinusBaselineLoss: number | null;
  pairedLossUpperBound: number | null;
  baselineEce: number | null;
  candidateEce: number | null;
  /** Means only that Lab output cleared this held-out gate; not that it may enforce. */
  eligibleForRoutingInput: boolean;
  reasons: string[];
}

/**
 * A deliberately conservative held-out gate. For paired Brier-loss differences
 * d_i in [-1,1], Hoeffding gives a one-sided upper confidence bound
 * mean(d) + sqrt(2 ln(1/alpha)/n). The candidate clears only when even that
 * upper bound beats the baseline by the configured minimum AND calibration does
 * not regress beyond tolerance.
 */
export function complexityCalibrationGate(
  observations: readonly ComplexityCalibrationObservation[],
  options: CalibrationGateOptions = {},
): CalibrationGateResult {
  const minSamples = options.minSamples ?? 100;
  const alpha = options.alpha ?? 0.05;
  const minBrierImprovement = options.minBrierImprovement ?? 0;
  const maxEceRegression = options.maxEceRegression ?? 0;
  const bins = options.bins ?? 10;

  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new Error('minSamples must be a positive integer');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('alpha must be in (0,1)');
  if (!Number.isFinite(minBrierImprovement) || minBrierImprovement < 0) throw new Error('minBrierImprovement must be non-negative');
  if (!Number.isFinite(maxEceRegression) || maxEceRegression < 0) throw new Error('maxEceRegression must be non-negative');

  const baseline: BinaryPrediction[] = [];
  const candidate: BinaryPrediction[] = [];
  const pairedDiffs: number[] = [];
  for (const [index, observation] of observations.entries()) {
    if (observation.outcome !== 0 && observation.outcome !== 1) throw new Error(`observation ${index} outcome must be 0 or 1`);
    validateProbability(observation.baselineProbability, `observation ${index} baselineProbability`);
    validateProbability(observation.candidateProbability, `observation ${index} candidateProbability`);
    baseline.push({ outcome: observation.outcome, probability: observation.baselineProbability });
    candidate.push({ outcome: observation.outcome, probability: observation.candidateProbability });
    const baselineError = observation.baselineProbability - observation.outcome;
    const candidateError = observation.candidateProbability - observation.outcome;
    pairedDiffs.push(candidateError * candidateError - baselineError * baselineError);
  }

  const baselineBrier = brierScore(baseline);
  const candidateBrier = brierScore(candidate);
  const baselineEce = expectedCalibrationError(baseline, bins);
  const candidateEce = expectedCalibrationError(candidate, bins);
  const meanDiff = pairedDiffs.length > 0 ? pairedDiffs.reduce((sum, value) => sum + value, 0) / pairedDiffs.length : null;
  const upperBound = meanDiff === null ? null : meanDiff + Math.sqrt(2 * Math.log(1 / alpha) / pairedDiffs.length);
  const brierImprovement = baselineBrier !== null && candidateBrier !== null ? baselineBrier - candidateBrier : null;

  const reasons: string[] = [];
  if (observations.length < minSamples) reasons.push(`only ${observations.length} held-out sample(s); need ${minSamples}`);
  if (upperBound === null || upperBound > -minBrierImprovement) {
    reasons.push('paired Brier-loss upper bound does not establish the required improvement over the simple baseline');
  }
  if (baselineEce === null || candidateEce === null || candidateEce > baselineEce + maxEceRegression) {
    reasons.push('candidate calibration error regresses beyond tolerance or is unknown');
  }

  return {
    sampleCount: observations.length,
    baselineBrier,
    candidateBrier,
    brierImprovement,
    pairedCandidateMinusBaselineLoss: meanDiff,
    pairedLossUpperBound: upperBound,
    baselineEce,
    candidateEce,
    eligibleForRoutingInput: reasons.length === 0,
    reasons,
  };
}

export interface ComplexityProfile {
  structural: number | null;
  informational: number | null;
  interaction: number | null;
  execution: number | null;
  epistemic: number | null;
  economic: number | null;
  modelSensitivity: number | null;
  predictedCompute: DistributionSummary | null;
  confidence: number | null;
  provenance: string[];
}

export interface DistributionSummary {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  cvar99: number | null;
}

function assertUnitOrNull(value: number | null, field: string): void {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be null or in [0,1]`);
}

/**
 * Envelope only: the Lab intentionally does not collapse these dimensions into
 * one magic scalar. Any aggregation would be a separate, explicit model.
 */
export function buildComplexityProfile(profile: ComplexityProfile): ComplexityProfile {
  for (const field of ['structural', 'informational', 'interaction', 'execution', 'epistemic', 'economic', 'modelSensitivity', 'confidence'] as const) {
    assertUnitOrNull(profile[field], field);
  }
  if (profile.provenance.length === 0) throw new Error('complexity profile requires provenance');
  return {
    ...profile,
    predictedCompute: profile.predictedCompute ? { ...profile.predictedCompute } : null,
    provenance: [...profile.provenance],
  };
}

export function sigmoid(value: number): number {
  if (!Number.isFinite(value)) throw new Error('sigmoid input must be finite');
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

/** Two-parameter logistic item-response model. */
export function irt2pl(ability: number, difficulty: number, discrimination: number): number {
  if (![ability, difficulty, discrimination].every(Number.isFinite)) throw new Error('IRT parameters must be finite');
  if (discrimination < 0) throw new Error('IRT discrimination must be non-negative');
  return sigmoid(discrimination * (ability - difficulty));
}

/** Multidimensional IRT research primitive; dimensions are explicit and aligned. */
export function multidimensionalIrt(
  abilities: readonly number[],
  difficulties: readonly number[],
  discriminations: readonly number[],
): number {
  if (abilities.length === 0 || abilities.length !== difficulties.length || abilities.length !== discriminations.length) {
    throw new Error('multidimensional IRT vectors must be non-empty and equal length');
  }
  let eta = 0;
  for (let i = 0; i < abilities.length; i += 1) {
    const ability = abilities[i]!;
    const difficulty = difficulties[i]!;
    const discrimination = discriminations[i]!;
    if (![ability, difficulty, discrimination].every(Number.isFinite) || discrimination < 0) throw new Error(`invalid IRT dimension ${i}`);
    eta += discrimination * (ability - difficulty);
  }
  return sigmoid(eta);
}

export interface PairwiseInteraction { i: number; j: number; weight: number }
export interface TripleInteraction { i: number; j: number; k: number; weight: number }
export interface InteractionModel {
  intercept: number;
  linear: readonly number[];
  pairwise?: readonly PairwiseInteraction[];
  triples?: readonly TripleInteraction[];
}

function assertIndex(index: number, length: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) throw new Error(`${label} index out of bounds`);
}

/**
 * Deliberately ambitious nonlinear failure model. It remains a pure evaluator;
 * fitting/regularization/calibration decide whether any interaction earns use.
 */
export function interactionFailureProbability(features: readonly number[], model: InteractionModel): number {
  if (!Number.isFinite(model.intercept)) throw new Error('interaction intercept must be finite');
  if (features.length !== model.linear.length) throw new Error('feature and linear-weight vectors must align');
  let eta = model.intercept;
  for (let i = 0; i < features.length; i += 1) {
    const feature = features[i]!;
    const weight = model.linear[i]!;
    if (!Number.isFinite(feature) || !Number.isFinite(weight)) throw new Error(`non-finite interaction input at ${i}`);
    eta += feature * weight;
  }
  for (const term of model.pairwise ?? []) {
    assertIndex(term.i, features.length, 'pairwise.i');
    assertIndex(term.j, features.length, 'pairwise.j');
    if (term.i === term.j || !Number.isFinite(term.weight)) throw new Error('pairwise interaction requires distinct indices and finite weight');
    eta += term.weight * features[term.i]! * features[term.j]!;
  }
  for (const term of model.triples ?? []) {
    assertIndex(term.i, features.length, 'triple.i');
    assertIndex(term.j, features.length, 'triple.j');
    assertIndex(term.k, features.length, 'triple.k');
    if (new Set([term.i, term.j, term.k]).size !== 3 || !Number.isFinite(term.weight)) throw new Error('triple interaction requires three distinct indices and finite weight');
    eta += term.weight * features[term.i]! * features[term.j]! * features[term.k]!;
  }
  return sigmoid(eta);
}

/** Dispersion of plan-quality predictions; zero means model choice is irrelevant on this signal. */
export function modelSensitivity(probabilities: readonly number[]): number | null {
  if (probabilities.length < 2) return null;
  for (const [index, probability] of probabilities.entries()) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`probability ${index} must be in [0,1]`);
  }
  const min = Math.min(...probabilities);
  const max = Math.max(...probabilities);
  return max - min;
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** Empirical compute-demand distribution for Lab calibration, never a routing claim by itself. */
export function summarizeComputeDistribution(samples: readonly number[]): DistributionSummary {
  if (samples.length === 0) return { count: 0, mean: null, p50: null, p90: null, p99: null, cvar99: null };
  const sorted = samples.map((sample, index) => {
    if (!Number.isFinite(sample) || sample < 0) throw new Error(`compute sample ${index} must be finite and non-negative`);
    return sample;
  }).sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const p99 = quantile(sorted, 0.99);
  const tailStart = Math.max(0, Math.ceil(0.99 * sorted.length) - 1);
  const tail = sorted.slice(tailStart);
  return {
    count: sorted.length,
    mean,
    p50: quantile(sorted, 0.50),
    p90: quantile(sorted, 0.90),
    p99,
    cvar99: tail.length > 0 ? tail.reduce((sum, value) => sum + value, 0) / tail.length : p99,
  };
}

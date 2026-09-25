/**
 * Provenance-aware off-policy evaluation (OPE) primitives.
 *
 * This module is intentionally a pure evidence boundary. It evaluates a
 * retained action log; it does not choose a policy, execute an action, or
 * turn an observational estimate into a causal treatment effect. Every row
 * must carry the logging propensity, treatment/action identity, target-policy
 * probability, pre-treatment context digest and policy provenance that make
 * the estimate interpretable. Missing support is a refusal, not a warning
 * attached to an otherwise usable number.
 */

import { canonicalJson, isCausalIdentifier, isSha256, sha256 } from './protocol.ts';

export const OPE_TYPE = 'segreant.causal.ope.evaluation' as const;
export const OPE_VERSION = 1 as const;

export type OpeEstimator = 'ips' | 'self_normalized_ips' | 'doubly_robust';
export type OpeStatus = 'supported';
export type OpeBiasStatus = 'none_identified' | 'not_identified_without_tail_model';

export type OpeErrorCode =
  | 'OPE_EVIDENCE_MISSING'
  | 'OPE_EVIDENCE_INVALID'
  | 'OPE_DUPLICATE_OBSERVATION'
  | 'OPE_POLICY_CONFLICT'
  | 'OPE_OVERLAP_UNSUPPORTED'
  | 'OPE_TAIL_RISK_UNCONTROLLED'
  | 'OPE_NO_TARGET_SUPPORT'
  | 'OPE_POST_TREATMENT_LEAKAGE'
  | 'OPE_MODEL_PROVENANCE_MISSING'
  | 'OPE_MODEL_PROVENANCE_CONFLICT';

export class OpeValidationError extends Error {
  override readonly name = 'OpeValidationError';
  readonly code: OpeErrorCode;

  constructor(code: OpeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface OpePolicyReference {
  readonly policyId: string;
  readonly version: string;
  /** Digest of the policy definition, not of this observation row. */
  readonly digest: string;
}

export interface OpeLoggingPolicyReference extends OpePolicyReference {
  /** Probability with which the logging policy selected this action. */
  readonly propensity: number;
}

export interface OpeTargetPolicyReference extends OpePolicyReference {
  /** Probability with which the evaluated target policy selects this action. */
  readonly probability: number;
}

export interface OpeContextReference {
  readonly schemaId: string;
  /** Digest only: raw prompts, source and context payloads are not retained here. */
  readonly digest: string;
  /** Last observation time for this context, which must precede treatment. */
  readonly observedAtMs: number;
}

export interface OpeOutcomeModelReference {
  readonly modelId: string;
  readonly version: string;
  readonly digest: string;
  /** Model expectation under the target policy's selected action. */
  readonly targetExpectedReward: number;
  /** Model expectation under the action actually logged. */
  readonly loggedExpectedReward: number;
  /** Model-training/evaluation evidence time; must be pre-action. */
  readonly observedAtMs: number;
}

export interface OpeObservation {
  readonly observationId: string;
  readonly unitId: string;
  readonly actionId: string;
  /** Explicit treatment identity; action labels alone are not enough. */
  readonly treatmentId: string;
  readonly reward: number;
  readonly actionAtMs: number;
  readonly outcomeAtMs: number;
  readonly context: OpeContextReference;
  readonly loggingPolicy: OpeLoggingPolicyReference;
  readonly targetPolicy: OpeTargetPolicyReference;
  readonly outcomeModel?: OpeOutcomeModelReference;
}

export interface OpeRewardBounds {
  readonly low: number;
  readonly high: number;
}

export interface OpeOverlapConstraints {
  /** Required minimum probability for every action with target support. */
  readonly minLoggingPropensity: number;
  /** Maximum un-clipped importance ratio accepted without tail evidence. */
  readonly maxImportanceWeight: number;
}

export interface OpeClippingPolicy {
  readonly maxWeight: number;
  readonly rationale: string;
}

export interface OpeEvaluationInput {
  readonly estimator: OpeEstimator;
  readonly observations: readonly OpeObservation[];
  readonly rewardBounds: OpeRewardBounds;
  readonly overlap: OpeOverlapConstraints;
  readonly policyConstraints: OpePolicyConstraints;
  readonly clipping?: OpeClippingPolicy;
}

export type OpeEvaluationOptions = Omit<OpeEvaluationInput, 'observations'>;

export interface OpePolicyConstraints {
  readonly policy: OpePolicyReference;
  readonly mode: 'fixed' | 'epsilon_greedy' | 'contextual';
  readonly explorationRate: number;
  readonly budgetUnitsPerObservationMax: number;
  readonly maxImportanceWeight: number;
  readonly maxTailContribution: number;
}

export interface OpeProvenance {
  readonly targetPolicy: OpePolicyReference;
  readonly loggingPolicies: readonly OpePolicyReference[];
  readonly contextSchemas: readonly string[];
  readonly outcomeModel?: { readonly modelId: string; readonly version: string; readonly digest: string };
  readonly digest: string;
}

export interface OpeOverlapReport {
  readonly supportedObservations: number;
  readonly zeroTargetProbabilityObservations: number;
  readonly minimumLoggingPropensity: number;
  readonly maximumImportanceWeight: number;
  readonly effectiveSampleSize: number;
}

export interface OpeClippingReport {
  readonly applied: boolean;
  readonly maxWeight: number | null;
  readonly clippedObservations: number;
  readonly biasStatus: OpeBiasStatus;
  readonly rationale: string | null;
}

export interface OpeEvaluation {
  readonly type: typeof OPE_TYPE;
  readonly version: typeof OPE_VERSION;
  readonly estimator: OpeEstimator;
  readonly status: OpeStatus;
  readonly estimate: number;
  readonly sampleSize: number;
  readonly overlap: OpeOverlapReport;
  readonly maxImportanceWeight: number;
  readonly clipping: OpeClippingReport;
  readonly policyConstraints: OpePolicyConstraints;
  readonly contributionRange: { readonly low: number; readonly high: number };
  readonly provenance: OpeProvenance;
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly nonClaims: readonly string[];
}

function fail(code: OpeErrorCode, message: string): never {
  throw new OpeValidationError(code, message);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveTimestamp(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value > 0;
}

function policyReference(value: OpePolicyReference, label: string): void {
  if (!isCausalIdentifier(value.policyId) || !isCausalIdentifier(value.version)) {
    fail('OPE_EVIDENCE_MISSING', `${label} identity and version are required`);
  }
  if (!isSha256(value.digest)) fail('OPE_EVIDENCE_INVALID', `${label}.digest must be a lowercase SHA-256 digest`);
}

function validateInput(input: OpeEvaluationInput): void {
  if (input.estimator !== 'ips' && input.estimator !== 'self_normalized_ips' && input.estimator !== 'doubly_robust') {
    fail('OPE_EVIDENCE_INVALID', 'estimator is not supported');
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    fail('OPE_EVIDENCE_MISSING', 'at least one retained action observation is required');
  }
  if (!finite(input.rewardBounds?.low) || !finite(input.rewardBounds?.high)
      || input.rewardBounds.low >= input.rewardBounds.high) {
    fail('OPE_EVIDENCE_INVALID', 'reward bounds must be finite with low < high');
  }
  if (!finite(input.overlap?.minLoggingPropensity)
      || input.overlap.minLoggingPropensity <= 0 || input.overlap.minLoggingPropensity > 1
      || !finite(input.overlap.maxImportanceWeight) || input.overlap.maxImportanceWeight <= 0) {
    fail('OPE_EVIDENCE_INVALID', 'overlap constraints are invalid');
  }
  policyReference(input.policyConstraints?.policy, 'policyConstraints.policy');
  if (!['fixed', 'epsilon_greedy', 'contextual'].includes(input.policyConstraints.mode)) {
    fail('OPE_EVIDENCE_INVALID', 'policyConstraints.mode is unsupported');
  }
  if (!finite(input.policyConstraints.explorationRate)
      || input.policyConstraints.explorationRate < 0
      || input.policyConstraints.explorationRate >= 1
      || !finite(input.policyConstraints.budgetUnitsPerObservationMax)
      || input.policyConstraints.budgetUnitsPerObservationMax < 0
      || !finite(input.policyConstraints.maxImportanceWeight)
      || input.policyConstraints.maxImportanceWeight <= 0
      || !finite(input.policyConstraints.maxTailContribution)
      || input.policyConstraints.maxTailContribution <= 0) {
    fail('OPE_EVIDENCE_INVALID', 'policyConstraints contains an invalid exploration, budget or tail-risk bound');
  }
  if (input.clipping !== undefined
      && (!finite(input.clipping.maxWeight) || input.clipping.maxWeight <= 0
        || !isCausalIdentifier(input.clipping.rationale))) {
    fail('OPE_EVIDENCE_INVALID', 'clipping requires a positive maxWeight and a rationale identifier');
  }

  const seen = new Set<string>();
  let targetPolicy: OpeTargetPolicyReference | undefined;
  let outcomeModel: OpeOutcomeModelReference | undefined;
  let supported = 0;
  for (const [index, row] of input.observations.entries()) {
    const label = `observation[${index}]`;
    if (!isCausalIdentifier(row.observationId) || !isCausalIdentifier(row.unitId)
        || !isCausalIdentifier(row.actionId) || !isCausalIdentifier(row.treatmentId)) {
      fail('OPE_EVIDENCE_MISSING', `${label} requires observation, unit, action and treatment identities`);
    }
    if (seen.has(row.observationId)) fail('OPE_DUPLICATE_OBSERVATION', `${label} repeats observationId ${row.observationId}`);
    seen.add(row.observationId);
    if (!finite(row.reward) || row.reward < input.rewardBounds.low || row.reward > input.rewardBounds.high) {
      fail('OPE_EVIDENCE_INVALID', `${label}.reward is outside the declared bounds`);
    }
    if (!positiveTimestamp(row.actionAtMs) || !positiveTimestamp(row.outcomeAtMs)) {
      fail('OPE_EVIDENCE_INVALID', `${label} action/outcome timestamps must be positive safe integers`);
    }
    if (row.outcomeAtMs < row.actionAtMs || !isCausalIdentifier(row.context.schemaId)
        || !isSha256(row.context.digest) || !positiveTimestamp(row.context.observedAtMs)
        || row.context.observedAtMs > row.actionAtMs) {
      fail('OPE_POST_TREATMENT_LEAKAGE', `${label} context/outcome timing is not pre-treatment safe`);
    }
    policyReference(row.loggingPolicy, `${label}.loggingPolicy`);
    policyReference(row.targetPolicy, `${label}.targetPolicy`);
    if (!finite(row.loggingPolicy.propensity) || row.loggingPolicy.propensity <= 0 || row.loggingPolicy.propensity > 1) {
      fail('OPE_EVIDENCE_MISSING', `${label} logging propensity is missing or outside (0,1]`);
    }
    if (!finite(row.targetPolicy.probability) || row.targetPolicy.probability < 0 || row.targetPolicy.probability > 1) {
      fail('OPE_EVIDENCE_INVALID', `${label} target policy probability is outside [0,1]`);
    }
    if (targetPolicy === undefined) targetPolicy = row.targetPolicy;
    else if (targetPolicy.policyId !== row.targetPolicy.policyId
        || targetPolicy.version !== row.targetPolicy.version || targetPolicy.digest !== row.targetPolicy.digest) {
      fail('OPE_POLICY_CONFLICT', 'all rows in one evaluation must use one target policy identity');
    }
    if (row.targetPolicy.policyId !== input.policyConstraints.policy.policyId
        || row.targetPolicy.version !== input.policyConstraints.policy.version
        || row.targetPolicy.digest !== input.policyConstraints.policy.digest) {
      fail('OPE_POLICY_CONFLICT', 'policyConstraints.policy must identify the target policy being evaluated');
    }
    if (row.targetPolicy.probability > 0) {
      supported += 1;
      if (row.loggingPolicy.propensity < input.overlap.minLoggingPropensity) {
        fail('OPE_OVERLAP_UNSUPPORTED', `${label} logging propensity is below the declared overlap floor`);
      }
      const weight = row.targetPolicy.probability / row.loggingPolicy.propensity;
      if (weight > input.overlap.maxImportanceWeight && input.clipping === undefined) {
        fail('OPE_TAIL_RISK_UNCONTROLLED', `${label} importance weight exceeds the declared tail-risk bound; provide explicit clipping`);
      }
      if (weight > input.policyConstraints.maxImportanceWeight
          && (input.clipping === undefined || input.clipping.maxWeight > input.policyConstraints.maxImportanceWeight)) {
        fail('OPE_TAIL_RISK_UNCONTROLLED', `${label} importance weight exceeds the exploration policy risk bound`);
      }
    }

    if (input.estimator === 'doubly_robust') {
      if (row.outcomeModel === undefined) fail('OPE_MODEL_PROVENANCE_MISSING', `${label} requires an outcome-model reference for doubly robust evaluation`);
      const model = row.outcomeModel;
      if (!isCausalIdentifier(model.modelId) || !isCausalIdentifier(model.version) || !isSha256(model.digest)
          || !finite(model.targetExpectedReward) || !finite(model.loggedExpectedReward)
          || model.targetExpectedReward < input.rewardBounds.low || model.targetExpectedReward > input.rewardBounds.high
          || model.loggedExpectedReward < input.rewardBounds.low || model.loggedExpectedReward > input.rewardBounds.high
          || !positiveTimestamp(model.observedAtMs) || model.observedAtMs > row.actionAtMs) {
        fail('OPE_MODEL_PROVENANCE_MISSING', `${label} outcome-model evidence is invalid or post-treatment`);
      }
      if (outcomeModel === undefined) outcomeModel = model;
      else if (outcomeModel.modelId !== model.modelId || outcomeModel.version !== model.version || outcomeModel.digest !== model.digest) {
        fail('OPE_MODEL_PROVENANCE_CONFLICT', 'all doubly robust rows must use one outcome-model identity');
      }
    } else if (row.outcomeModel !== undefined) {
      policyReference({ policyId: row.outcomeModel.modelId, version: row.outcomeModel.version, digest: row.outcomeModel.digest }, `${label}.outcomeModel`);
    }
  }
  if (supported === 0) fail('OPE_NO_TARGET_SUPPORT', 'target policy has zero positive-probability observations');
}

function quantile95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function validateOpeInput(input: OpeEvaluationInput): void {
  validateInput(input);
}

export function evaluateOpe(input: OpeEvaluationInput): OpeEvaluation {
  validateInput(input);
  const target = input.observations[0]!.targetPolicy;
  const loggingPolicies = new Map<string, OpePolicyReference>();
  const contextSchemas = new Set<string>();
  const weights: number[] = [];
  const contributions: number[] = [];
  let clippedObservations = 0;
  let minLoggingPropensity = 1;
  let maximumImportanceWeight = 0;
  let totalWeight = 0;
  let totalWeightSquared = 0;

  for (const row of input.observations) {
    const rawWeight = row.targetPolicy.probability / row.loggingPolicy.propensity;
    const weight = input.clipping === undefined ? rawWeight : Math.min(rawWeight, input.clipping.maxWeight);
    if (rawWeight > (input.clipping?.maxWeight ?? Number.POSITIVE_INFINITY)) clippedObservations += 1;
    if (row.targetPolicy.probability > 0) {
      maximumImportanceWeight = Math.max(maximumImportanceWeight, rawWeight);
      minLoggingPropensity = Math.min(minLoggingPropensity, row.loggingPolicy.propensity);
    }
    weights.push(weight);
    totalWeight += weight;
    totalWeightSquared += weight * weight;
    contextSchemas.add(row.context.schemaId);
    loggingPolicies.set(`${row.loggingPolicy.policyId}@${row.loggingPolicy.version}@${row.loggingPolicy.digest}`, {
      policyId: row.loggingPolicy.policyId,
      version: row.loggingPolicy.version,
      digest: row.loggingPolicy.digest,
    });
    if (input.estimator === 'doubly_robust') {
      const model = row.outcomeModel!;
      contributions.push(model.targetExpectedReward + weight * (row.reward - model.loggedExpectedReward));
    } else {
      contributions.push(weight * row.reward);
    }
  }

  if (!(totalWeight > 0)) fail('OPE_NO_TARGET_SUPPORT', 'target policy has no positive recorded support');
  const estimate = input.estimator === 'self_normalized_ips'
    ? contributions.reduce((sum, value) => sum + value, 0) / totalWeight
    : contributions.reduce((sum, value) => sum + value, 0) / input.observations.length;
  const effectiveSampleSize = (totalWeight * totalWeight) / totalWeightSquared;
  const sortedContributions = [...contributions].sort((a, b) => a - b);
  const clippingApplied = clippedObservations > 0;
  const clipping: OpeClippingReport = {
    applied: clippingApplied,
    maxWeight: input.clipping?.maxWeight ?? null,
    clippedObservations,
    biasStatus: clippingApplied ? 'not_identified_without_tail_model' : 'none_identified',
    rationale: input.clipping?.rationale ?? null,
  };
  const provenanceMaterial = {
    type: OPE_TYPE,
    version: OPE_VERSION,
    estimator: input.estimator,
    targetPolicy: target,
    loggingPolicies: [...loggingPolicies.values()].sort((a, b) => `${a.policyId}@${a.version}`.localeCompare(`${b.policyId}@${b.version}`)),
    contextSchemas: [...contextSchemas].sort(),
    outcomeModel: input.estimator === 'doubly_robust' ? {
      modelId: input.observations[0]!.outcomeModel!.modelId,
      version: input.observations[0]!.outcomeModel!.version,
      digest: input.observations[0]!.outcomeModel!.digest,
    } : null,
    observations: input.observations.map((row) => ({
      observationId: row.observationId,
      unitId: row.unitId,
      actionId: row.actionId,
      treatmentId: row.treatmentId,
      contextDigest: row.context.digest,
      actionAtMs: row.actionAtMs,
      outcomeAtMs: row.outcomeAtMs,
      targetProbability: row.targetPolicy.probability,
      loggingPropensity: row.loggingPolicy.propensity,
      reward: row.reward,
    })),
  };
  const outcomeModel = input.estimator === 'doubly_robust' ? {
    modelId: input.observations[0]!.outcomeModel!.modelId,
    version: input.observations[0]!.outcomeModel!.version,
    digest: input.observations[0]!.outcomeModel!.digest,
  } : undefined;
  const assumptions = [
    'The retained logging policy probabilities are the probabilities that generated each observed action.',
    'The target-policy probabilities and treatment identities are fixed before each outcome.',
    'Positive target support is contained in the observed logging support (overlap).',
    input.estimator === 'self_normalized_ips'
      ? 'Self-normalized IPS trades finite-sample bias for variance reduction and is not the ordinary IPS estimand.'
      : input.estimator === 'doubly_robust'
        ? 'The outcome model is pre-treatment and its policy/action identity is independently versioned; consistency or model correctness is not proven here.'
        : 'The IPS estimate is the unnormalized mean of importance-weighted observed rewards.',
    `The declared policy constraint mode is ${input.policyConstraints.mode} with exploration rate ${input.policyConstraints.explorationRate}; these limits are recorded, not proof that a runtime controller obeyed them.`,
  ];
  const limitations = [
    'This is an off-policy value estimate under declared logging assumptions, not a causal treatment effect.',
    'The evaluation does not establish that the logging policy probabilities were honestly generated or that outcomes are independent.',
    'Context is represented by a digest and schema identity; raw prompts, source and credentials are intentionally absent.',
    ...(clippingApplied ? ['Clipping changes the estimand and its bias is not identified without a declared tail model.'] : []),
    'Budget units are a caller-declared policy basis; this module does not convert them into provider money or execute a budget action.',
  ];
  return Object.freeze({
    type: OPE_TYPE,
    version: OPE_VERSION,
    estimator: input.estimator,
    status: 'supported',
    estimate,
    sampleSize: input.observations.length,
    overlap: {
      supportedObservations: input.observations.filter((row) => row.targetPolicy.probability > 0).length,
      zeroTargetProbabilityObservations: input.observations.filter((row) => row.targetPolicy.probability === 0).length,
      minimumLoggingPropensity: minLoggingPropensity,
      maximumImportanceWeight,
      effectiveSampleSize,
    },
    maxImportanceWeight: maximumImportanceWeight,
    clipping,
    policyConstraints: Object.freeze({ ...input.policyConstraints, policy: { ...input.policyConstraints.policy } }),
    contributionRange: { low: sortedContributions[0] ?? 0, high: sortedContributions.at(-1) ?? 0 },
    provenance: {
      targetPolicy: { ...target },
      loggingPolicies: Object.freeze([...loggingPolicies.values()].sort((a, b) => `${a.policyId}@${a.version}`.localeCompare(`${b.policyId}@${b.version}`))),
      contextSchemas: Object.freeze([...contextSchemas].sort()),
      ...(outcomeModel === undefined ? {} : { outcomeModel }),
      digest: sha256(`segreant.ope\n${OPE_VERSION}\n${canonicalJson(provenanceMaterial)}`),
    },
    assumptions: Object.freeze(assumptions),
    limitations: Object.freeze(limitations),
    nonClaims: Object.freeze([
      'Not a causal treatment effect or randomized-study result.',
      'Not proof that a target policy is safe, optimal, or authorized to execute.',
      'Not a retrospective comparison of models without action-level propensity evidence.',
    ]),
  });
}

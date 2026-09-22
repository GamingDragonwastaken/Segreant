/**
 * Local paired randomized experiment analysis for causal *incremental* return.
 *
 * This is intentionally separate from the ordinary RoI report. A local ledger,
 * a baseline, or a model comparison can be valuable observational evidence, but
 * cannot establish a treatment effect by itself. This module accepts only a
 * pre-specified paired allocation with completed outcomes, validates the
 * structure mechanically, and reports an operator-attested estimate with a
 * conservative finite-sample interval.
 *
 * It does not verify that an operator used the allocation in the real world,
 * that recorded outcomes are complete, or that an exported plan was not
 * rewritten before sharing. Those are explicit limitations in every result.
 */

import { createHash, randomBytes } from 'node:crypto';

export const CAUSAL_EXPERIMENT_TYPE = 'fiscus.paired-causal-return' as const;
export const CAUSAL_EXPERIMENT_VERSION = 1 as const;

export type CausalArm = 'ai' | 'control';

export interface CausalPairCandidate {
  pairId: string;
  stratum: string;
  unitAId: string;
  unitBId: string;
}

export interface CausalAssignment {
  pairId: string;
  stratum: string;
  aiUnitId: string;
  controlUnitId: string;
}

export interface PairedCausalExperimentPlan {
  version: typeof CAUSAL_EXPERIMENT_VERSION;
  type: typeof CAUSAL_EXPERIMENT_TYPE;
  experimentId: string;
  createdAt: string;
  /**
   * The outcome-value-minus-human-labour-benefit of each unit must be within
   * these bounds. They are declared before recording outcomes, so the interval
   * cannot use a range chosen after seeing a favorable effect.
   */
  benefitBoundsUsd: { low: number; high: number };
  confidenceLevel: number;
  laborRatePerHour: number;
  randomization: {
    method: 'fiscus_local_csprng_per_pair';
    materialHex: string;
    materialSha256: string;
  };
  candidates: CausalPairCandidate[];
  assignments: CausalAssignment[];
}

export interface CausalObservation {
  experimentId: string;
  planHash: string;
  pairId: string;
  unitId: string;
  arm: CausalArm;
  /** Pre-specified business-outcome value, measured consistently across arms. */
  outcomeValueUsd: number;
  /** Directly measured human work time for the unit. */
  humanMinutes: number;
  /** Directly observed AI cost. A no-AI control must be exactly zero. */
  aiCostUsd: number;
}

export interface PairedCausalExperimentInput {
  experimentId: string;
  createdAt?: string;
  benefitBoundsUsd: { low: number; high: number };
  confidenceLevel?: number;
  laborRatePerHour: number;
  pairs: CausalPairCandidate[];
  /** Test seam only; production defaults to Node's cryptographic random source. */
  randomizationMaterial?: Uint8Array;
}

export interface CausalReturnInterval {
  point: number;
  low: number;
  high: number;
}

export interface PairedCausalExperimentAnalysis {
  ok: boolean;
  errors: string[];
  planHash: string | null;
  pairCount: number;
  confidenceLevel: number | null;
  /** Treatment minus control, excluding direct AI spend from the numerator. */
  incrementalBenefitUsd: CausalReturnInterval | null;
  /** Observed treatment-only AI spend per randomized pair. */
  incrementalAiCostUsd: number | null;
  /** Incremental benefit per observed incremental AI dollar. */
  causalIncrementalReturn: CausalReturnInterval | null;
  evidence: {
    grade: 'not_established' | 'operator_attested_randomized_paired_estimate';
    breakEven: 'not_established' | 'supported_within_operator_attested_protocol';
    limitations: string[];
  };
}

type ParsedPlan = { plan: PairedCausalExperimentPlan | null; errors: string[] };
type ParsedObservations = { observations: CausalObservation[]; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function sortedUnique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('cannot canonicalize an unsupported value');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorResult(errors: string[], planHash: string | null = null, pairCount = 0, confidenceLevel: number | null = null): PairedCausalExperimentAnalysis {
  return {
    ok: false,
    errors,
    planHash,
    pairCount,
    confidenceLevel,
    incrementalBenefitUsd: null,
    incrementalAiCostUsd: null,
    causalIncrementalReturn: null,
    evidence: {
      grade: 'not_established',
      breakEven: 'not_established',
      limitations: [
        'No causal estimate was produced because the declared paired randomized protocol did not validate.',
        'Ordinary Fiscus usage, spend, and outcome records remain observational unless a validated experiment is supplied.',
      ],
    },
  };
}

function parseCandidates(value: unknown, errors: string[]): CausalPairCandidate[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('plan.candidates must contain at least one pre-specified pair');
    return null;
  }
  const candidates: CausalPairCandidate[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !validId(raw.pairId) || !validId(raw.stratum) || !validId(raw.unitAId) || !validId(raw.unitBId)) {
      errors.push('plan.candidates[' + index + '] has an invalid pairId, stratum, or unit id');
      continue;
    }
    if (raw.unitAId === raw.unitBId) errors.push('plan.candidates[' + index + '] repeats the same unit in both arms');
    candidates.push({ pairId: raw.pairId, stratum: raw.stratum, unitAId: raw.unitAId, unitBId: raw.unitBId });
  }
  if (!sortedUnique(candidates.map((candidate) => candidate.pairId))) errors.push('plan.candidates has duplicate pairId values');
  if (!sortedUnique(candidates.flatMap((candidate) => [candidate.unitAId, candidate.unitBId]))) errors.push('a candidate unit may belong to only one pair');
  return candidates;
}

function parseAssignments(value: unknown, errors: string[]): CausalAssignment[] | null {
  if (!Array.isArray(value)) {
    errors.push('plan.assignments must be an array');
    return null;
  }
  const assignments: CausalAssignment[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !validId(raw.pairId) || !validId(raw.stratum) || !validId(raw.aiUnitId) || !validId(raw.controlUnitId)) {
      errors.push('plan.assignments[' + index + '] has an invalid pairId, stratum, or unit id');
      continue;
    }
    if (raw.aiUnitId === raw.controlUnitId) errors.push('plan.assignments[' + index + '] assigns one unit to both arms');
    assignments.push({ pairId: raw.pairId, stratum: raw.stratum, aiUnitId: raw.aiUnitId, controlUnitId: raw.controlUnitId });
  }
  if (!sortedUnique(assignments.map((assignment) => assignment.pairId))) errors.push('plan.assignments has duplicate pairId values');
  return assignments;
}

function allocationFor(candidates: CausalPairCandidate[], material: Uint8Array): CausalAssignment[] {
  return candidates.map((candidate, index) => {
    const byte = material[Math.floor(index / 8)] ?? 0;
    const firstIsAi = ((byte >> (index % 8)) & 1) === 1;
    return {
      pairId: candidate.pairId,
      stratum: candidate.stratum,
      aiUnitId: firstIsAi ? candidate.unitAId : candidate.unitBId,
      controlUnitId: firstIsAi ? candidate.unitBId : candidate.unitAId,
    };
  });
}

function sameAssignment(left: CausalAssignment, right: CausalAssignment): boolean {
  return left.pairId === right.pairId &&
    left.stratum === right.stratum &&
    left.aiUnitId === right.aiUnitId &&
    left.controlUnitId === right.controlUnitId;
}

function parsePlan(value: unknown): ParsedPlan {
  const errors: string[] = [];
  if (!isRecord(value)) return { plan: null, errors: ['plan must be an object'] };
  if (value.version !== CAUSAL_EXPERIMENT_VERSION || value.type !== CAUSAL_EXPERIMENT_TYPE) {
    errors.push('plan has an unsupported causal experiment type or version');
  }
  if (!validId(value.experimentId)) errors.push('plan.experimentId is invalid');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) errors.push('plan.createdAt must be an ISO timestamp');
  if (!isRecord(value.benefitBoundsUsd) || !isFiniteNumber(value.benefitBoundsUsd.low) || !isFiniteNumber(value.benefitBoundsUsd.high) || value.benefitBoundsUsd.low >= value.benefitBoundsUsd.high) {
    errors.push('plan.benefitBoundsUsd must be a finite low < high interval declared before outcomes');
  }
  if (!isFiniteNumber(value.confidenceLevel) || value.confidenceLevel <= 0 || value.confidenceLevel >= 1) errors.push('plan.confidenceLevel must be between 0 and 1');
  if (!isFiniteNumber(value.laborRatePerHour) || value.laborRatePerHour <= 0) errors.push('plan.laborRatePerHour must be positive');
  if (!isRecord(value.randomization) || value.randomization.method !== 'fiscus_local_csprng_per_pair' ||
      typeof value.randomization.materialHex !== 'string' || !/^[a-f0-9]+$/i.test(value.randomization.materialHex) || value.randomization.materialHex.length % 2 !== 0 ||
      typeof value.randomization.materialSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.randomization.materialSha256)) {
    errors.push('plan.randomization must contain Fiscus local CSPRNG material and its SHA-256 commitment');
  }
  const candidates = parseCandidates(value.candidates, errors);
  const assignments = parseAssignments(value.assignments, errors);
  if (!candidates || !assignments) return { plan: null, errors };
  const material = isRecord(value.randomization) && typeof value.randomization.materialHex === 'string'
    ? Buffer.from(value.randomization.materialHex, 'hex')
    : null;
  if (material && material.length < Math.ceil(candidates.length / 8)) errors.push('plan.randomization material is too short for every pair');
  if (material && isRecord(value.randomization) && sha256(material) !== value.randomization.materialSha256) errors.push('plan.randomization material does not match its SHA-256 commitment');
  if (assignments.length !== candidates.length) errors.push('plan.assignments must contain exactly one allocation for each candidate pair');
  if (material && assignments.length === candidates.length) {
    const expected = allocationFor(candidates, material);
    for (let index = 0; index < expected.length; index += 1) {
      if (!sameAssignment(assignments[index]!, expected[index]!)) {
        errors.push('plan.assignments does not match the recorded randomization material at index ' + index);
      }
    }
  }
  if (errors.length > 0) return { plan: null, errors };
  return {
    plan: value as unknown as PairedCausalExperimentPlan,
    errors: [],
  };
}

function parseObservations(value: unknown): ParsedObservations {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { observations: [], errors: ['observations must be an array'] };
  const observations: CausalObservation[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || !validId(raw.experimentId) || typeof raw.planHash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.planHash) ||
      !validId(raw.pairId) || !validId(raw.unitId) || (raw.arm !== 'ai' && raw.arm !== 'control') ||
      !isFiniteNumber(raw.outcomeValueUsd) || raw.outcomeValueUsd < 0 ||
      !isFiniteNumber(raw.humanMinutes) || raw.humanMinutes < 0 ||
      !isFiniteNumber(raw.aiCostUsd) || raw.aiCostUsd < 0) {
      errors.push('observations[' + index + '] has an invalid id, arm, or non-negative finite measurement');
      continue;
    }
    observations.push({
      experimentId: raw.experimentId,
      planHash: raw.planHash,
      pairId: raw.pairId,
      unitId: raw.unitId,
      arm: raw.arm,
      outcomeValueUsd: raw.outcomeValueUsd,
      humanMinutes: raw.humanMinutes,
      aiCostUsd: raw.aiCostUsd,
    });
  }
  return { observations, errors };
}

/**
 * Produces a transparent, pre-specified paired allocation. The material is
 * retained so Fiscus can independently replay the allocation later; it is not
 * a claim that an operator could not rewrite a local file before sharing it.
 */
export function createPairedCausalExperiment(input: PairedCausalExperimentInput): PairedCausalExperimentPlan {
  const material = input.randomizationMaterial ?? randomBytes(Math.max(1, Math.ceil(input.pairs.length / 8)));
  const candidateErrors: string[] = [];
  const candidates = parseCandidates(input.pairs, candidateErrors);
  if (!validId(input.experimentId) || !candidates || candidateErrors.length > 0 ||
      !isFiniteNumber(input.benefitBoundsUsd.low) || !isFiniteNumber(input.benefitBoundsUsd.high) || input.benefitBoundsUsd.low >= input.benefitBoundsUsd.high ||
      !isFiniteNumber(input.laborRatePerHour) || input.laborRatePerHour <= 0) {
    throw new Error('cannot create causal experiment: ' + candidateErrors.concat('check id, pairs, benefit bounds, and labor rate').join('; '));
  }
  const confidenceLevel = input.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) throw new Error('cannot create causal experiment: confidenceLevel must be between 0 and 1');
  if (material.length < Math.ceil(candidates.length / 8)) throw new Error('cannot create causal experiment: randomization material is too short');
  return {
    version: CAUSAL_EXPERIMENT_VERSION,
    type: CAUSAL_EXPERIMENT_TYPE,
    experimentId: input.experimentId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    benefitBoundsUsd: { low: input.benefitBoundsUsd.low, high: input.benefitBoundsUsd.high },
    confidenceLevel,
    laborRatePerHour: input.laborRatePerHour,
    randomization: {
      method: 'fiscus_local_csprng_per_pair',
      materialHex: Buffer.from(material).toString('hex'),
      materialSha256: sha256(material),
    },
    candidates: candidates.map((candidate) => ({ ...candidate })),
    assignments: allocationFor(candidates, material),
  };
}

/** A stable identifier observations must bind to before their measurements count. */
export function causalExperimentPlanHash(plan: PairedCausalExperimentPlan): string {
  return sha256(canonical(plan));
}

/**
 * Analyze a complete paired protocol. The confidence interval uses Hoeffding's
 * finite-sample bound over the pre-registered benefit range, so it does not
 * assume normal outcomes or estimate a favorable variance after the fact.
 */
export function analyzePairedCausalExperiment(planInput: unknown, observationsInput: unknown): PairedCausalExperimentAnalysis {
  const parsedPlan = parsePlan(planInput);
  if (!parsedPlan.plan) return errorResult(parsedPlan.errors);
  const plan = parsedPlan.plan;
  const planHash = causalExperimentPlanHash(plan);
  const parsedObservations = parseObservations(observationsInput);
  const errors = [...parsedObservations.errors];
  const byPair = new Map<string, CausalObservation[]>();
  for (const observation of parsedObservations.observations) {
    if (observation.experimentId !== plan.experimentId) errors.push('observation ' + observation.unitId + ' belongs to a different experiment');
    if (observation.planHash !== planHash) errors.push('observation ' + observation.unitId + ' does not bind the exact pre-specified plan hash');
    const list = byPair.get(observation.pairId) ?? [];
    list.push(observation);
    byPair.set(observation.pairId, list);
  }
  const differences: number[] = [];
  const costs: number[] = [];
  for (const assignment of plan.assignments) {
    const observations = byPair.get(assignment.pairId) ?? [];
    if (observations.length !== 2) {
      errors.push('pair ' + assignment.pairId + ' must contain exactly two observations');
      continue;
    }
    const ai = observations.find((observation) => observation.arm === 'ai');
    const control = observations.find((observation) => observation.arm === 'control');
    if (!ai || !control) {
      errors.push('pair ' + assignment.pairId + ' must contain one ai and one control observation');
      continue;
    }
    if (ai.unitId !== assignment.aiUnitId || control.unitId !== assignment.controlUnitId) {
      errors.push('pair ' + assignment.pairId + ' does not follow its pre-specified allocation');
      continue;
    }
    if (control.aiCostUsd !== 0) errors.push('control unit ' + control.unitId + ' has non-zero AI cost and is not a no-AI control');
    const aiBenefit = ai.outcomeValueUsd - (ai.humanMinutes * plan.laborRatePerHour / 60);
    const controlBenefit = control.outcomeValueUsd - (control.humanMinutes * plan.laborRatePerHour / 60);
    if (aiBenefit < plan.benefitBoundsUsd.low || aiBenefit > plan.benefitBoundsUsd.high ||
        controlBenefit < plan.benefitBoundsUsd.low || controlBenefit > plan.benefitBoundsUsd.high) {
      errors.push('pair ' + assignment.pairId + ' has an observed benefit outside the pre-registered benefit bounds');
      continue;
    }
    differences.push(aiBenefit - controlBenefit);
    costs.push(ai.aiCostUsd);
  }
  const knownPairIds = new Set(plan.assignments.map((assignment) => assignment.pairId));
  for (const pairId of byPair.keys()) if (!knownPairIds.has(pairId)) errors.push('observations include an unknown pair ' + pairId);
  if (errors.length > 0) return errorResult(errors, planHash, plan.assignments.length, plan.confidenceLevel);
  const n = differences.length;
  if (n === 0) return errorResult(['no complete valid pairs remain after protocol validation'], planHash, 0, plan.confidenceLevel);
  const point = differences.reduce((sum, value) => sum + value, 0) / n;
  const pairBenefitWidth = plan.benefitBoundsUsd.high - plan.benefitBoundsUsd.low;
  const alpha = 1 - plan.confidenceLevel;
  const radius = pairBenefitWidth * Math.sqrt((2 * Math.log(2 / alpha)) / n);
  const differenceLow = Math.max(-pairBenefitWidth, point - radius);
  const differenceHigh = Math.min(pairBenefitWidth, point + radius);
  const incrementalAiCostUsd = costs.reduce((sum, value) => sum + value, 0) / n;
  const causalIncrementalReturn = incrementalAiCostUsd > 0
    ? { point: point / incrementalAiCostUsd, low: differenceLow / incrementalAiCostUsd, high: differenceHigh / incrementalAiCostUsd }
    : null;
  const breakEven = causalIncrementalReturn !== null && causalIncrementalReturn.low >= 1
    ? 'supported_within_operator_attested_protocol'
    : 'not_established';
  return {
    ok: true,
    errors: [],
    planHash,
    pairCount: n,
    confidenceLevel: plan.confidenceLevel,
    incrementalBenefitUsd: { point, low: differenceLow, high: differenceHigh },
    incrementalAiCostUsd,
    causalIncrementalReturn,
    evidence: {
      grade: 'operator_attested_randomized_paired_estimate',
      breakEven,
      limitations: [
        'Fiscus verified the declared paired allocation, plan hash binding, no-AI control cost, fixed outcome bounds, and arithmetic locally.',
        'The estimate assumes random assignment was followed, no cross-unit interference, comparable paired tasks, complete outcome recording, and a consistent pre-specified value measure.',
        'The plan and observations are local operator-attested artifacts. This result is not independently audited, provider-billed, organization-authorized, or a recommendation to change spend.',
      ],
    },
  };
}

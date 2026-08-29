/**
 * Validation, canonicalisation, and local commitment helpers for causal-study
 * protocols. Hashes make retained local records reproducible; they are not a
 * claim of independent audit or universal tamper resistance.
 */

import { createHash } from 'node:crypto';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  type CausalStudyProtocolDraft,
  type CommittedCausalStudyProtocol,
} from './types.ts';

const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

export function isCausalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function validBounds(value: unknown): value is { low: number; high: number } {
  return isRecord(value) && finite(value.low) && finite(value.high) && value.low < value.high;
}

function exactlyTwo<T>(values: readonly T[]): boolean {
  return values.length === 2;
}

function idsAreUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function rejectUnexpectedKeys(
  value: unknown,
  allowed: string[],
  label: string,
  errors: string[],
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(label + ' has unsupported field: ' + key);
  }
}

/**
 * Canonical JSON is used only for stable local content hashing. It rejects
 * undefined/functions/symbols rather than silently changing the value being
 * committed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}';
  }
  throw new Error('cannot canonicalize unsupported value');
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function protocolMaterial(draft: CausalStudyProtocolDraft): CausalStudyProtocolDraft {
  return {
    type: draft.type,
    version: draft.version,
    studyId: draft.studyId,
    createdAtMs: draft.createdAtMs,
    question: draft.question,
    eligibility: {
      cohortId: draft.eligibility.cohortId,
      unitOfAssignment: draft.eligibility.unitOfAssignment,
      contextSchemaId: draft.eligibility.contextSchemaId,
    },
    arms: draft.arms.map((arm) => ({
      armId: arm.armId,
      role: arm.role,
      executionPlanHash: arm.executionPlanHash,
      providerId: arm.providerId,
      modelId: arm.modelId,
    })),
    allocation: {
      method: draft.allocation.method,
      probabilityPerArm: draft.allocation.probabilityPerArm,
      blockSize: draft.allocation.blockSize,
    },
    costOutcome: {
      metricId: draft.costOutcome.metricId,
      boundsUsd: { low: draft.costOutcome.boundsUsd.low, high: draft.costOutcome.boundsUsd.high },
      acceptedSourceClasses: [...draft.costOutcome.acceptedSourceClasses],
    },
    qualityOutcome: {
      metricId: draft.qualityOutcome.metricId,
      bounds: { low: draft.qualityOutcome.bounds.low, high: draft.qualityOutcome.bounds.high },
      evidenceClass: draft.qualityOutcome.evidenceClass,
      nonInferiorityMargin: draft.qualityOutcome.nonInferiorityMargin,
    },
    economicOutcome: draft.economicOutcome
      ? {
          metricId: draft.economicOutcome.metricId,
          boundsUsd: { low: draft.economicOutcome.boundsUsd.low, high: draft.economicOutcome.boundsUsd.high },
          evidenceClass: draft.economicOutcome.evidenceClass,
          fullCostAccountingRequired: true,
        }
      : null,
    analysis: {
      estimand: draft.analysis.estimand,
      confidenceLevel: draft.analysis.confidenceLevel,
      minCompletedPerArm: draft.analysis.minCompletedPerArm,
      maxMissingFractionPerArm: draft.analysis.maxMissingFractionPerArm,
    },
  };
}

export function protocolHash(draft: CausalStudyProtocolDraft): string {
  return sha256(canonicalJson(protocolMaterial(draft)));
}

/**
 * Return every design error rather than failing on the first one, so an
 * operator cannot unknowingly correct one defect while retaining another.
 */
export function validateCausalProtocol(draft: CausalStudyProtocolDraft): string[] {
  const errors: string[] = [];
  if (!isRecord(draft)) return ['protocol must be an object'];
  rejectUnexpectedKeys(draft, [
    'type', 'version', 'studyId', 'createdAtMs', 'question', 'eligibility',
    'arms', 'allocation', 'costOutcome', 'qualityOutcome', 'economicOutcome',
    'analysis',
  ], 'protocol', errors);
  if (draft.type !== CAUSAL_PROTOCOL_TYPE || draft.version !== CAUSAL_PROTOCOL_VERSION) {
    errors.push('protocol has an unsupported type or version');
  }
  if (!isCausalIdentifier(draft.studyId)) errors.push('studyId must be a compact identifier, not free text');
  if (!positiveInteger(draft.createdAtMs)) errors.push('createdAtMs must be a positive integer epoch timestamp');
  if (draft.question !== 'model_cost_quality' && draft.question !== 'ai_vs_incumbent_net_benefit') {
    errors.push('question must be model_cost_quality or ai_vs_incumbent_net_benefit');
  }
  if (!isRecord(draft.eligibility) ||
      !isCausalIdentifier(draft.eligibility.cohortId) ||
      !isCausalIdentifier(draft.eligibility.contextSchemaId) ||
      !['agent_run', 'task', 'request', 'repository_change', 'workflow_block'].includes(draft.eligibility.unitOfAssignment)) {
    errors.push('eligibility must contain declared cohort, assignment unit, and context schema identifiers');
  }
  rejectUnexpectedKeys(draft.eligibility, ['cohortId', 'unitOfAssignment', 'contextSchemaId'], 'eligibility', errors);
  if (!Array.isArray(draft.arms) || !exactlyTwo(draft.arms)) {
    errors.push('version 1 requires exactly two predeclared arms');
  } else {
    const ids = draft.arms.map((arm) => arm.armId);
    if (!idsAreUnique(ids)) errors.push('arm identifiers must be unique');
    for (const arm of draft.arms) {
      rejectUnexpectedKeys(arm, ['armId', 'role', 'executionPlanHash', 'providerId', 'modelId'], 'arm', errors);
      if (!isCausalIdentifier(arm.armId) || !isSha256(arm.executionPlanHash)) {
        errors.push('every arm needs an identifier and exact execution-plan SHA-256');
      }
      if (arm.providerId !== null && !isCausalIdentifier(arm.providerId)) errors.push('arm providerId must be an identifier or null');
      if (arm.modelId !== null && !isCausalIdentifier(arm.modelId)) errors.push('arm modelId must be an identifier or null');
    }
    const roles = draft.arms.map((arm) => arm.role);
    if (draft.question === 'model_cost_quality' &&
        !(roles.includes('candidate') && roles.includes('control'))) {
      errors.push('model_cost_quality requires one candidate and one control arm');
    }
    if (draft.question === 'ai_vs_incumbent_net_benefit' &&
        !(roles.includes('ai') && (roles.includes('incumbent') || roles.includes('no_ai')))) {
      errors.push('ai_vs_incumbent_net_benefit requires an ai arm and an incumbent or no_ai control arm');
    }
  }
  if (!isRecord(draft.allocation) ||
      draft.allocation.method !== 'blocked_randomized_equal_allocation' ||
      !finite(draft.allocation.probabilityPerArm) ||
      Math.abs(draft.allocation.probabilityPerArm - 0.5) > Number.EPSILON ||
      !positiveInteger(draft.allocation.blockSize) ||
      draft.allocation.blockSize % 2 !== 0) {
    errors.push('version 1 requires an even, 1:1 blocked randomisation allocation');
  }
  rejectUnexpectedKeys(draft.allocation, ['method', 'probabilityPerArm', 'blockSize'], 'allocation', errors);
  if (!isRecord(draft.costOutcome) ||
      !isCausalIdentifier(draft.costOutcome.metricId) ||
      !validBounds(draft.costOutcome.boundsUsd) ||
      !Array.isArray(draft.costOutcome.acceptedSourceClasses) ||
      draft.costOutcome.acceptedSourceClasses.length === 0 ||
      !draft.costOutcome.acceptedSourceClasses.every((v) => v === 'actual_reconciled' || v === 'actual_observed')) {
    errors.push('cost outcome requires declared finite bounds and actual observed/reconciled source classes');
  }
  rejectUnexpectedKeys(draft.costOutcome, ['metricId', 'boundsUsd', 'acceptedSourceClasses'], 'cost outcome', errors);
  if (isRecord(draft.costOutcome)) rejectUnexpectedKeys(draft.costOutcome.boundsUsd, ['low', 'high'], 'cost bounds', errors);
  if (!isRecord(draft.qualityOutcome) ||
      !isCausalIdentifier(draft.qualityOutcome.metricId) ||
      !validBounds(draft.qualityOutcome.bounds) ||
      !finite(draft.qualityOutcome.nonInferiorityMargin) ||
      draft.qualityOutcome.nonInferiorityMargin < 0 ||
      draft.qualityOutcome.evidenceClass === 'local_ai_judge' ||
      !['deterministic', 'independent_operational', 'structured_human', 'operator_attested'].includes(draft.qualityOutcome.evidenceClass)) {
    errors.push('quality outcome requires finite bounds, a predeclared margin, and non-judge evidence');
  }
  rejectUnexpectedKeys(draft.qualityOutcome, ['metricId', 'bounds', 'evidenceClass', 'nonInferiorityMargin'], 'quality outcome', errors);
  if (isRecord(draft.qualityOutcome)) rejectUnexpectedKeys(draft.qualityOutcome.bounds, ['low', 'high'], 'quality bounds', errors);
  if (draft.question === 'ai_vs_incumbent_net_benefit') {
    if (!draft.economicOutcome ||
        !isCausalIdentifier(draft.economicOutcome.metricId) ||
        !validBounds(draft.economicOutcome.boundsUsd) ||
        draft.economicOutcome.fullCostAccountingRequired !== true) {
      errors.push('ai_vs_incumbent_net_benefit requires an actual economic outcome and full-cost accounting');
    }
  } else if (draft.economicOutcome !== null) {
    errors.push('model_cost_quality must not smuggle an economic net-benefit outcome into the protocol');
  }
  if (draft.economicOutcome !== null) {
    rejectUnexpectedKeys(draft.economicOutcome, ['metricId', 'boundsUsd', 'evidenceClass', 'fullCostAccountingRequired'], 'economic outcome', errors);
    if (isRecord(draft.economicOutcome)) rejectUnexpectedKeys(draft.economicOutcome.boundsUsd, ['low', 'high'], 'economic bounds', errors);
  }
  if (!isRecord(draft.analysis) ||
      draft.analysis.estimand !== 'intention_to_treat' ||
      !finite(draft.analysis.confidenceLevel) ||
      draft.analysis.confidenceLevel <= 0 ||
      draft.analysis.confidenceLevel >= 1 ||
      !positiveInteger(draft.analysis.minCompletedPerArm) ||
      !finite(draft.analysis.maxMissingFractionPerArm) ||
      draft.analysis.maxMissingFractionPerArm < 0 ||
      draft.analysis.maxMissingFractionPerArm >= 1) {
    errors.push('analysis requires ITT, a valid confidence level, sample floor, and missingness limit');
  }
  rejectUnexpectedKeys(draft.analysis, ['estimand', 'confidenceLevel', 'minCompletedPerArm', 'maxMissingFractionPerArm'], 'analysis', errors);
  return errors;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** Commit a validated protocol before any eligible unit is exposed. */
export function commitCausalProtocol(
  draft: CausalStudyProtocolDraft,
  committedAtMs = Date.now(),
): CommittedCausalStudyProtocol {
  const errors = validateCausalProtocol(draft);
  if (!positiveInteger(committedAtMs)) errors.push('committedAtMs must be a positive integer epoch timestamp');
  if (committedAtMs < draft.createdAtMs) errors.push('committedAtMs cannot precede createdAtMs');
  if (errors.length > 0) throw new Error('cannot commit causal protocol: ' + errors.join('; '));
  const copied = clone(protocolMaterial(draft));
  return deepFreeze({
    ...copied,
    lifecycle: 'committed',
    committedAtMs,
    protocolHash: protocolHash(copied),
  });
}

/** Verify a retained commitment before it may be used for assignment or analysis. */
export function verifyCommittedCausalProtocol(protocol: CommittedCausalStudyProtocol): string[] {
  const errors = validateCausalProtocol(protocolMaterial(protocol));
  if (protocol.lifecycle !== 'committed') errors.push('protocol lifecycle must be committed');
  if (!positiveInteger(protocol.committedAtMs) || protocol.committedAtMs < protocol.createdAtMs) {
    errors.push('committedAtMs is invalid');
  }
  if (!isSha256(protocol.protocolHash) || protocol.protocolHash !== protocolHash(protocol)) {
    errors.push('protocol hash does not match the committed structural protocol');
  }
  return errors;
}

/**
 * A hash-linked local event. This detects changes against a retained event
 * chain, but does not by itself make a local filesystem independently
 * tamper-proof.
 */
export function causalEventHash(event: Record<string, unknown>): string {
  const { eventHash: _ignored, ...material } = event;
  return sha256(canonicalJson(material));
}

export function verifyCausalEvent(event: Record<string, unknown>): boolean {
  return isSha256(event.eventHash) && event.eventHash === causalEventHash(event);
}

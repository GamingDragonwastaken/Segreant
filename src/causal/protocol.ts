/**
 * Validation, canonicalisation, and local commitment helpers for causal-study
 * protocols. Hashes make retained local records reproducible; they are not a
 * claim of independent audit or universal tamper resistance.
 */

import { createHash } from 'node:crypto';
import {
  CAUSAL_PROTOCOL_TYPE,
  CAUSAL_PROTOCOL_VERSION,
  CAUSAL_PROTOCOL_VERSION_V2,
  type AnyCommittedCausalStudyProtocol,
  type CausalStudyProtocolDraftV2,
  type CommittedCausalStudyProtocolV2,
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

function positiveSafeIntegerV2(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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

function protocolMaterialV1(draft: CausalStudyProtocolDraft): CausalStudyProtocolDraft {
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

function protocolHashV1(draft: CausalStudyProtocolDraft): string {
  return sha256(canonicalJson(protocolMaterialV1(draft)));
}

/**
 * Return every design error rather than failing on the first one, so an
 * operator cannot unknowingly correct one defect while retaining another.
 */
function validateCausalProtocolV1(draft: CausalStudyProtocolDraft): string[] {
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

const V2_NAMESPACED_ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const V2_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const V2_PROTOCOL_KEYS = [
  'type', 'version', 'studyId', 'seriesId', 'studyVersion', 'ownerId', 'scopeId',
  'createdAtMs', 'question', 'eligibility', 'studyWindow', 'stoppingRule', 'arms',
  'allocation', 'costOutcome', 'qualityOutcome', 'economicOutcome', 'analysis',
  'dataGovernance', 'claimTemplateIds',
] as const;

function validateExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(label + ' must be an object');
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(label + ' is missing required field: ' + key);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(label + ' has unsupported field: ' + key);
  }
  return true;
}

function safeV2Scalar(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== 'string') {
    errors.push(label + ' must be a string');
    return false;
  }
  const hasUnsafeAscii = [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code > 0x7e || code === 0x7f;
  });
  const hasUrl = /:\/\//.test(value) || /^(?:https?|file|data|javascript|mailto):/i.test(value);
  const hasPath = /[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  const hasCredential = /^(?:bearer|basic)\s/i.test(value)
    || /api[_-]?key|secret|password|token/i.test(value)
    || /(?:^|[:._-])(?:sk|rk|pk)-[A-Za-z0-9]/i.test(value)
    || /(?:^|:)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value);
  if (value.length === 0 || value !== value.trim() || hasUnsafeAscii || hasUrl || hasPath || hasCredential) {
    const reason = hasUrl ? 'URL' : hasPath ? 'path' : hasCredential ? 'credential' : hasUnsafeAscii ? 'control/non-ASCII' : 'unsafe whitespace';
    errors.push(label + ' must be a safe ASCII scalar without ' + reason + ' material');
    return false;
  }
  return true;
}

function validateV2Id(value: unknown, label: string, errors: string[]): value is string {
  if (!safeV2Scalar(value, label, errors)) return false;
  if (!V2_NAMESPACED_ID_RE.test(value) || value.length < 3 || value.length > 160) {
    errors.push(label + ' must match the NamespacedId grammar');
    return false;
  }
  return true;
}

function validateV2Digest(value: unknown, label: string, errors: string[]): value is string {
  if (!safeV2Scalar(value, label, errors)) return false;
  if (!V2_DIGEST_RE.test(value)) {
    errors.push(label + ' must be a lowercase namespaced SHA-256 Digest');
    return false;
  }
  return true;
}

function safeEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateDenseArray(value: unknown, label: string, errors: string[]): value is unknown[] {
  if (!Array.isArray(value)) {
    errors.push(label + ' must be an array');
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      errors.push(label + ' must not be sparse');
      return false;
    }
  }
  return true;
}

function validateSortedUniqueIds(
  value: unknown,
  label: string,
  errors: string[],
  nonempty: boolean,
): value is string[] {
  if (!validateDenseArray(value, label, errors)) return false;
  if (nonempty && value.length === 0) errors.push(label + ' must be nonempty');
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (validateV2Id(item, label + '[' + index + ']', errors)) strings.push(item);
  }
  if (new Set(strings).size !== strings.length) errors.push(label + ' must not contain duplicates');
  if (strings.some((item, index) => index > 0 && strings[index - 1]! > item)) {
    errors.push(label + ' must be lexicographically sorted');
  }
  return strings.length === value.length;
}

function validateSortedUniqueDigests(value: unknown, label: string, errors: string[]): value is string[] {
  if (!validateDenseArray(value, label, errors)) return false;
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (validateV2Digest(item, label + '[' + index + ']', errors)) strings.push(item);
  }
  if (new Set(strings).size !== strings.length) errors.push(label + ' must not contain duplicates');
  if (strings.some((item, index) => index > 0 && strings[index - 1]! > item)) {
    errors.push(label + ' must be lexicographically sorted');
  }
  return strings.length === value.length;
}

function validateV2Bounds(value: unknown, label: string, errors: string[]): boolean {
  if (!validateExactRecord(value, ['low', 'high'], label, errors)) return false;
  if (!finite(value.low) || !finite(value.high) || value.low >= value.high) {
    errors.push(label + ' must contain finite low < high');
    return false;
  }
  return true;
}

function validateEvidenceClassV2(value: unknown, label: string, errors: string[]): boolean {
  if (value === 'local_ai_judge') {
    errors.push(label + ' rejects local_ai_judge');
    return false;
  }
  if (!['deterministic', 'independent_operational', 'structured_human', 'operator_attested'].includes(String(value))) {
    errors.push(label + ' must be a supported EvidenceClass');
    return false;
  }
  return true;
}

function validateClosedSortedSourceClasses(value: unknown, label: string, errors: string[]): boolean {
  if (!validateDenseArray(value, label, errors)) return false;
  if (value.length === 0) errors.push(label + ' must be nonempty');
  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length !== value.length || strings.some((item) => item !== 'actual_reconciled' && item !== 'actual_observed')) {
    errors.push(label + ' must contain only actual observed/reconciled source classes');
  }
  if (new Set(strings).size !== strings.length) errors.push(label + ' must not contain duplicates');
  if (strings.some((item, index) => index > 0 && strings[index - 1]! > item)) errors.push(label + ' must be lexicographically sorted');
  return errors.length === 0;
}

function protocolMaterialV2(draft: CausalStudyProtocolDraftV2): CausalStudyProtocolDraftV2 {
  return {
    type: draft.type,
    version: draft.version,
    studyId: draft.studyId,
    seriesId: draft.seriesId,
    studyVersion: draft.studyVersion,
    ownerId: draft.ownerId,
    scopeId: draft.scopeId,
    createdAtMs: draft.createdAtMs,
    question: draft.question,
    eligibility: {
      cohortId: draft.eligibility.cohortId,
      contextSchemaId: draft.eligibility.contextSchemaId,
      unitOfAssignment: draft.eligibility.unitOfAssignment,
      inclusionRuleIds: [...draft.eligibility.inclusionRuleIds],
      exclusionRuleIds: [...draft.eligibility.exclusionRuleIds],
    },
    studyWindow: { startsAtMs: draft.studyWindow.startsAtMs, endsAtMs: draft.studyWindow.endsAtMs },
    stoppingRule: { kind: draft.stoppingRule.kind, maxAssignments: draft.stoppingRule.maxAssignments },
    arms: draft.arms.map((arm) => ({
      armId: arm.armId,
      role: arm.role,
      executionPlanDigest: arm.executionPlanDigest,
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
      currency: draft.costOutcome.currency,
      boundsUsd: { low: draft.costOutcome.boundsUsd.low, high: draft.costOutcome.boundsUsd.high },
      acceptedSourceClasses: [...draft.costOutcome.acceptedSourceClasses],
      priceLineageRule: draft.costOutcome.priceLineageRule,
    },
    qualityOutcome: {
      metricId: draft.qualityOutcome.metricId,
      collectionMethodId: draft.qualityOutcome.collectionMethodId,
      bounds: { low: draft.qualityOutcome.bounds.low, high: draft.qualityOutcome.bounds.high },
      evidenceClass: draft.qualityOutcome.evidenceClass,
      nonInferiorityMargin: draft.qualityOutcome.nonInferiorityMargin,
    },
    economicOutcome: draft.economicOutcome === null ? null : {
      metricId: draft.economicOutcome.metricId,
      collectionMethodId: draft.economicOutcome.collectionMethodId,
      currency: draft.economicOutcome.currency,
      boundsUsd: { low: draft.economicOutcome.boundsUsd.low, high: draft.economicOutcome.boundsUsd.high },
      evidenceClass: draft.economicOutcome.evidenceClass,
      fullCostAccountingRequired: true,
    },
    analysis: {
      estimand: draft.analysis.estimand,
      confidenceLevel: draft.analysis.confidenceLevel,
      minCompletedPerArm: draft.analysis.minCompletedPerArm,
      maxMissingFractionPerArm: draft.analysis.maxMissingFractionPerArm,
      exclusionPolicyId: draft.analysis.exclusionPolicyId,
    },
    dataGovernance: {
      minimizedSourceIds: [...draft.dataGovernance.minimizedSourceIds],
      retentionClassId: draft.dataGovernance.retentionClassId,
      egressReceiptDigests: [...draft.dataGovernance.egressReceiptDigests],
    },
    claimTemplateIds: {
      qualified: draft.claimTemplateIds.qualified,
      inconclusive: draft.claimTemplateIds.inconclusive,
      invalid: draft.claimTemplateIds.invalid,
    },
  };
}

function protocolHashV2Validated(draft: CausalStudyProtocolDraftV2): string {
  const material = protocolMaterialV2(draft);
  return 'sha256:' + sha256('fiscus.causal.protocol\n2\n' + canonicalJson(material));
}

function validateCausalProtocolV2(draft: unknown): string[] {
  const errors: string[] = [];
  if (!validateExactRecord(draft, V2_PROTOCOL_KEYS, 'protocol', errors)) return errors;

  if (draft.type !== CAUSAL_PROTOCOL_TYPE || draft.version !== CAUSAL_PROTOCOL_VERSION_V2) {
    errors.push('protocol has an unsupported type or version');
  }
  validateV2Id(draft.studyId, 'studyId', errors);
  validateV2Id(draft.seriesId, 'seriesId', errors);
  if (!positiveSafeIntegerV2(draft.studyVersion)) errors.push('studyVersion must be a positive safe integer');
  validateV2Id(draft.ownerId, 'ownerId', errors);
  validateV2Id(draft.scopeId, 'scopeId', errors);
  if (!safeEpoch(draft.createdAtMs)) errors.push('createdAtMs must be a positive safe-integer epoch timestamp');
  if (draft.question !== 'model_cost_quality' && draft.question !== 'ai_vs_incumbent_net_benefit') {
    errors.push('question must be model_cost_quality or ai_vs_incumbent_net_benefit');
  }

  if (validateExactRecord(
    draft.eligibility,
    ['cohortId', 'contextSchemaId', 'unitOfAssignment', 'inclusionRuleIds', 'exclusionRuleIds'],
    'eligibility',
    errors,
  )) {
    validateV2Id(draft.eligibility.cohortId, 'eligibility.cohortId', errors);
    validateV2Id(draft.eligibility.contextSchemaId, 'eligibility.contextSchemaId', errors);
    if (!['agent_run', 'task', 'request', 'repository_change', 'workflow_block'].includes(String(draft.eligibility.unitOfAssignment))) {
      errors.push('eligibility.unitOfAssignment is unsupported');
    }
    validateSortedUniqueIds(draft.eligibility.inclusionRuleIds, 'eligibility.inclusionRuleIds', errors, true);
    validateSortedUniqueIds(draft.eligibility.exclusionRuleIds, 'eligibility.exclusionRuleIds', errors, false);
  }

  let startsAtMs: number | null = null;
  let endsAtMs: number | null = null;
  if (validateExactRecord(draft.studyWindow, ['startsAtMs', 'endsAtMs'], 'studyWindow', errors)) {
    if (!safeEpoch(draft.studyWindow.startsAtMs)) errors.push('studyWindow.startsAtMs must be a positive safe-integer epoch timestamp');
    else startsAtMs = draft.studyWindow.startsAtMs;
    if (draft.studyWindow.endsAtMs !== null && !safeEpoch(draft.studyWindow.endsAtMs)) {
      errors.push('studyWindow.endsAtMs must be null or a positive safe-integer epoch timestamp');
    } else {
      endsAtMs = draft.studyWindow.endsAtMs;
    }
    if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
      errors.push('studyWindow.endsAtMs must be greater than startsAtMs');
    }
    if (safeEpoch(draft.createdAtMs) && startsAtMs !== null && draft.createdAtMs > startsAtMs) {
      errors.push('createdAtMs cannot follow studyWindow.startsAtMs');
    }
  }

  let stoppingKind: unknown;
  let maxAssignments: unknown;
  if (validateExactRecord(draft.stoppingRule, ['kind', 'maxAssignments'], 'stoppingRule', errors)) {
    stoppingKind = draft.stoppingRule.kind;
    maxAssignments = draft.stoppingRule.maxAssignments;
    if (!['fixed_enrollment', 'fixed_time', 'fixed_enrollment_or_time'].includes(String(stoppingKind))) {
      errors.push('stoppingRule.kind is unsupported');
    }
    if (maxAssignments !== null && !positiveSafeIntegerV2(maxAssignments)) {
      errors.push('stoppingRule.maxAssignments must be null or a positive safe integer');
    }
    if (stoppingKind === 'fixed_enrollment' && (maxAssignments === null || endsAtMs !== null)) {
      errors.push('stoppingRule fixed_enrollment requires maxAssignments and a null window end');
    }
    if (stoppingKind === 'fixed_time' && (maxAssignments !== null || endsAtMs === null)) {
      errors.push('stoppingRule fixed_time requires a window end and null maxAssignments');
    }
    if (stoppingKind === 'fixed_enrollment_or_time' && (maxAssignments === null || endsAtMs === null)) {
      errors.push('stoppingRule fixed_enrollment_or_time requires maxAssignments and a window end');
    }
  }

  const armIds: string[] = [];
  const armRoles: string[] = [];
  if (validateDenseArray(draft.arms, 'arms', errors)) {
    if (draft.arms.length !== 2) errors.push('v2 protocol requires exactly two ordered arms');
    for (let index = 0; index < draft.arms.length; index += 1) {
      const arm = draft.arms[index];
      const label = 'arms[' + index + ']';
      if (!validateExactRecord(arm, ['armId', 'role', 'executionPlanDigest', 'providerId', 'modelId'], label, errors)) continue;
      if (validateV2Id(arm.armId, label + '.armId', errors)) armIds.push(arm.armId);
      if (!['candidate', 'control', 'ai', 'incumbent', 'no_ai'].includes(String(arm.role))) errors.push(label + '.role is unsupported');
      else armRoles.push(String(arm.role));
      validateV2Digest(arm.executionPlanDigest, label + '.executionPlanDigest', errors);
      if (arm.providerId !== null) validateV2Id(arm.providerId, label + '.providerId', errors);
      if (arm.modelId !== null) validateV2Id(arm.modelId, label + '.modelId', errors);
    }
    if (new Set(armIds).size !== armIds.length) errors.push('arm identifiers must be unique');
    if (draft.question === 'model_cost_quality' && !(armRoles.includes('candidate') && armRoles.includes('control'))) {
      errors.push('model_cost_quality requires one candidate and one control arm');
    }
    if (draft.question === 'ai_vs_incumbent_net_benefit'
      && !(armRoles.includes('ai') && (armRoles.includes('incumbent') || armRoles.includes('no_ai')))) {
      errors.push('ai_vs_incumbent_net_benefit requires an ai arm and an incumbent or no_ai control arm');
    }
  }

  let blockSize: number | null = null;
  if (validateExactRecord(draft.allocation, ['method', 'probabilityPerArm', 'blockSize'], 'allocation', errors)) {
    if (draft.allocation.method !== 'blocked_randomized_equal_allocation') errors.push('allocation.method is unsupported');
    if (draft.allocation.probabilityPerArm !== 0.5) errors.push('allocation.probabilityPerArm must equal 0.5');
    if (!positiveSafeIntegerV2(draft.allocation.blockSize) || draft.allocation.blockSize % 2 !== 0) {
      errors.push('allocation.blockSize must be a positive even safe integer');
    } else {
      blockSize = draft.allocation.blockSize;
    }
  }
  if (positiveSafeIntegerV2(maxAssignments) && blockSize !== null && maxAssignments % blockSize !== 0) {
    errors.push('stoppingRule.maxAssignments must be a multiple of allocation.blockSize');
  }

  if (validateExactRecord(
    draft.costOutcome,
    ['metricId', 'currency', 'boundsUsd', 'acceptedSourceClasses', 'priceLineageRule'],
    'costOutcome',
    errors,
  )) {
    validateV2Id(draft.costOutcome.metricId, 'costOutcome.metricId', errors);
    if (draft.costOutcome.currency !== 'USD') errors.push('costOutcome.currency must be USD');
    validateV2Bounds(draft.costOutcome.boundsUsd, 'costOutcome.boundsUsd', errors);
    validateClosedSortedSourceClasses(draft.costOutcome.acceptedSourceClasses, 'costOutcome.acceptedSourceClasses', errors);
    if (draft.costOutcome.priceLineageRule !== 'every_included_cost_has_retained_sha256_lineage') {
      errors.push('costOutcome.priceLineageRule is unsupported');
    }
  }

  if (validateExactRecord(
    draft.qualityOutcome,
    ['metricId', 'collectionMethodId', 'bounds', 'evidenceClass', 'nonInferiorityMargin'],
    'qualityOutcome',
    errors,
  )) {
    validateV2Id(draft.qualityOutcome.metricId, 'qualityOutcome.metricId', errors);
    validateV2Id(draft.qualityOutcome.collectionMethodId, 'qualityOutcome.collectionMethodId', errors);
    validateV2Bounds(draft.qualityOutcome.bounds, 'qualityOutcome.bounds', errors);
    validateEvidenceClassV2(draft.qualityOutcome.evidenceClass, 'qualityOutcome.evidenceClass', errors);
    if (!finite(draft.qualityOutcome.nonInferiorityMargin) || draft.qualityOutcome.nonInferiorityMargin < 0) {
      errors.push('qualityOutcome.nonInferiorityMargin must be finite and nonnegative');
    }
  }

  if (draft.question === 'model_cost_quality' && draft.economicOutcome !== null) {
    errors.push('model_cost_quality requires economicOutcome to be null');
  }
  if (draft.question === 'ai_vs_incumbent_net_benefit' && draft.economicOutcome === null) {
    errors.push('ai_vs_incumbent_net_benefit requires economicOutcome');
  }
  if (draft.economicOutcome !== null && validateExactRecord(
    draft.economicOutcome,
    ['metricId', 'collectionMethodId', 'currency', 'boundsUsd', 'evidenceClass', 'fullCostAccountingRequired'],
    'economicOutcome',
    errors,
  )) {
    validateV2Id(draft.economicOutcome.metricId, 'economicOutcome.metricId', errors);
    validateV2Id(draft.economicOutcome.collectionMethodId, 'economicOutcome.collectionMethodId', errors);
    if (draft.economicOutcome.currency !== 'USD') errors.push('economicOutcome.currency must be USD');
    validateV2Bounds(draft.economicOutcome.boundsUsd, 'economicOutcome.boundsUsd', errors);
    validateEvidenceClassV2(draft.economicOutcome.evidenceClass, 'economicOutcome.evidenceClass', errors);
    if (draft.economicOutcome.fullCostAccountingRequired !== true) {
      errors.push('economicOutcome.fullCostAccountingRequired must be true');
    }
  }

  if (validateExactRecord(
    draft.analysis,
    ['estimand', 'confidenceLevel', 'minCompletedPerArm', 'maxMissingFractionPerArm', 'exclusionPolicyId'],
    'analysis',
    errors,
  )) {
    if (draft.analysis.estimand !== 'intention_to_treat') errors.push('analysis.estimand must be intention_to_treat');
    if (!finite(draft.analysis.confidenceLevel) || draft.analysis.confidenceLevel <= 0 || draft.analysis.confidenceLevel >= 1) {
      errors.push('analysis.confidenceLevel must be finite and strictly between zero and one');
    }
    if (!positiveSafeIntegerV2(draft.analysis.minCompletedPerArm)) {
      errors.push('analysis.minCompletedPerArm must be a positive safe integer');
    }
    if (!finite(draft.analysis.maxMissingFractionPerArm)
      || draft.analysis.maxMissingFractionPerArm < 0
      || draft.analysis.maxMissingFractionPerArm >= 1) {
      errors.push('analysis.maxMissingFractionPerArm must be finite in [0,1)');
    }
    validateV2Id(draft.analysis.exclusionPolicyId, 'analysis.exclusionPolicyId', errors);
  }

  if (validateExactRecord(
    draft.dataGovernance,
    ['minimizedSourceIds', 'retentionClassId', 'egressReceiptDigests'],
    'dataGovernance',
    errors,
  )) {
    validateSortedUniqueIds(draft.dataGovernance.minimizedSourceIds, 'dataGovernance.minimizedSourceIds', errors, true);
    validateV2Id(draft.dataGovernance.retentionClassId, 'dataGovernance.retentionClassId', errors);
    validateSortedUniqueDigests(draft.dataGovernance.egressReceiptDigests, 'dataGovernance.egressReceiptDigests', errors);
  }

  if (validateExactRecord(draft.claimTemplateIds, ['qualified', 'inconclusive', 'invalid'], 'claimTemplateIds', errors)) {
    const templates = [draft.claimTemplateIds.qualified, draft.claimTemplateIds.inconclusive, draft.claimTemplateIds.invalid];
    validateV2Id(templates[0], 'claimTemplateIds.qualified', errors);
    validateV2Id(templates[1], 'claimTemplateIds.inconclusive', errors);
    validateV2Id(templates[2], 'claimTemplateIds.invalid', errors);
    if (new Set(templates).size !== templates.length) errors.push('claimTemplateIds values must be distinct');
  }

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
function commitCausalProtocolV1(
  draft: CausalStudyProtocolDraft,
  committedAtMs = Date.now(),
): CommittedCausalStudyProtocol {
  const errors = validateCausalProtocolV1(draft);
  if (!positiveInteger(committedAtMs)) errors.push('committedAtMs must be a positive integer epoch timestamp');
  if (committedAtMs < draft.createdAtMs) errors.push('committedAtMs cannot precede createdAtMs');
  if (errors.length > 0) throw new Error('cannot commit causal protocol: ' + errors.join('; '));
  const copied = clone(protocolMaterialV1(draft));
  return deepFreeze({
    ...copied,
    lifecycle: 'committed',
    committedAtMs,
    protocolHash: protocolHashV1(copied),
  });
}

/** Verify a retained commitment before it may be used for assignment or analysis. */
function verifyCommittedCausalProtocolV1(protocol: CommittedCausalStudyProtocol): string[] {
  const errors = validateCausalProtocolV1(protocolMaterialV1(protocol));
  if (protocol.lifecycle !== 'committed') errors.push('protocol lifecycle must be committed');
  if (!positiveInteger(protocol.committedAtMs) || protocol.committedAtMs < protocol.createdAtMs) {
    errors.push('committedAtMs is invalid');
  }
  if (!isSha256(protocol.protocolHash) || protocol.protocolHash !== protocolHashV1(protocol)) {
    errors.push('protocol hash does not match the committed structural protocol');
  }
  return errors;
}

function commitCausalProtocolV2(
  draft: CausalStudyProtocolDraftV2,
  committedAtMs = Date.now(),
): CommittedCausalStudyProtocolV2 {
  const errors = validateCausalProtocolV2(draft);
  if (!safeEpoch(committedAtMs)) errors.push('committedAtMs must be a positive safe-integer epoch timestamp');
  if (safeEpoch(committedAtMs) && committedAtMs < draft.createdAtMs) {
    errors.push('committedAtMs cannot precede createdAtMs');
  }
  const studyWindow = draft.studyWindow;
  if (
    safeEpoch(committedAtMs)
    && isRecord(studyWindow)
    && safeEpoch(studyWindow.startsAtMs)
    && committedAtMs > studyWindow.startsAtMs
  ) {
    errors.push('committedAtMs cannot follow studyWindow.startsAtMs');
  }
  if (errors.length > 0) throw new Error('cannot commit causal protocol: ' + errors.join('; '));
  const copied = clone(protocolMaterialV2(draft));
  return deepFreeze({
    ...copied,
    lifecycle: 'committed',
    committedAtMs,
    protocolHash: protocolHashV2Validated(copied),
  });
}

function verifyCommittedCausalProtocolV2(protocol: unknown): string[] {
  const errors: string[] = [];
  const committedKeys = [...V2_PROTOCOL_KEYS, 'lifecycle', 'committedAtMs', 'protocolHash'];
  if (!validateExactRecord(protocol, committedKeys, 'committed protocol', errors)) return errors;

  const draftCandidate = { ...protocol };
  delete draftCandidate.lifecycle;
  delete draftCandidate.committedAtMs;
  delete draftCandidate.protocolHash;
  errors.push(...validateCausalProtocolV2(draftCandidate));

  if (protocol.lifecycle !== 'committed') errors.push('protocol lifecycle must be committed');
  if (!safeEpoch(protocol.committedAtMs)) {
    errors.push('committedAtMs must be a positive safe-integer epoch timestamp');
  } else {
    if (safeEpoch(protocol.createdAtMs) && protocol.committedAtMs < protocol.createdAtMs) {
      errors.push('committedAtMs cannot precede createdAtMs');
    }
    const window = protocol.studyWindow;
    if (isRecord(window) && safeEpoch(window.startsAtMs) && protocol.committedAtMs > window.startsAtMs) {
      errors.push('committedAtMs cannot follow studyWindow.startsAtMs');
    }
  }
  const digestValid = validateV2Digest(protocol.protocolHash, 'protocolHash', errors);
  if (digestValid && errors.length === 0) {
    const expected = protocolHashV2Validated(draftCandidate as unknown as CausalStudyProtocolDraftV2);
    if (protocol.protocolHash !== expected) errors.push('protocol hash does not match the committed v2 structural protocol');
  }
  return errors;
}

function runtimeProtocolVersion(value: unknown): 1 | 2 | null {
  if (!isRecord(value)) return null;
  if (value.version === CAUSAL_PROTOCOL_VERSION) return CAUSAL_PROTOCOL_VERSION;
  if (value.version === CAUSAL_PROTOCOL_VERSION_V2) return CAUSAL_PROTOCOL_VERSION_V2;
  return null;
}

function invalidProtocolRoot(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [label + ' must be an object'];
  return [label + ' has an unsupported type or version'];
}

function causalProtocolOperationError(operation: 'hash' | 'commit', errors: string[]): Error {
  return new Error('cannot ' + operation + ' causal protocol: ' + errors.join('; '));
}

export function validateCausalProtocol(draft: CausalStudyProtocolDraft): string[];
export function validateCausalProtocol(draft: CausalStudyProtocolDraftV2): string[];
export function validateCausalProtocol(draft: unknown): string[];
export function validateCausalProtocol(draft: unknown): string[] {
  const version = runtimeProtocolVersion(draft);
  if (version === CAUSAL_PROTOCOL_VERSION) return validateCausalProtocolV1(draft as CausalStudyProtocolDraft);
  if (version === CAUSAL_PROTOCOL_VERSION_V2) return validateCausalProtocolV2(draft);
  return invalidProtocolRoot(draft, 'protocol');
}

export function protocolHash(draft: CausalStudyProtocolDraft): string;
export function protocolHash(draft: CausalStudyProtocolDraftV2): string;
export function protocolHash(draft: unknown): string;
export function protocolHash(draft: unknown): string {
  const errors = validateCausalProtocol(draft);
  if (errors.length > 0) throw causalProtocolOperationError('hash', errors);
  const version = runtimeProtocolVersion(draft);
  if (version === CAUSAL_PROTOCOL_VERSION) return protocolHashV1(draft as CausalStudyProtocolDraft);
  if (version === CAUSAL_PROTOCOL_VERSION_V2) {
    return protocolHashV2Validated(draft as CausalStudyProtocolDraftV2);
  }
  throw causalProtocolOperationError('hash', invalidProtocolRoot(draft, 'protocol'));
}

export function commitCausalProtocol(
  draft: CausalStudyProtocolDraft,
  committedAtMs?: number,
): CommittedCausalStudyProtocol;
export function commitCausalProtocol(
  draft: CausalStudyProtocolDraftV2,
  committedAtMs?: number,
): CommittedCausalStudyProtocolV2;
export function commitCausalProtocol(
  draft: unknown,
  committedAtMs?: number,
): AnyCommittedCausalStudyProtocol;
export function commitCausalProtocol(
  draft: unknown,
  committedAtMs = Date.now(),
): AnyCommittedCausalStudyProtocol {
  const version = runtimeProtocolVersion(draft);
  if (version === CAUSAL_PROTOCOL_VERSION) {
    return commitCausalProtocolV1(draft as CausalStudyProtocolDraft, committedAtMs);
  }
  if (version === CAUSAL_PROTOCOL_VERSION_V2) {
    return commitCausalProtocolV2(draft as CausalStudyProtocolDraftV2, committedAtMs);
  }
  throw causalProtocolOperationError('commit', invalidProtocolRoot(draft, 'protocol'));
}

export function verifyCommittedCausalProtocol(protocol: CommittedCausalStudyProtocol): string[];
export function verifyCommittedCausalProtocol(protocol: CommittedCausalStudyProtocolV2): string[];
export function verifyCommittedCausalProtocol(protocol: unknown): string[];
export function verifyCommittedCausalProtocol(protocol: unknown): string[] {
  const version = runtimeProtocolVersion(protocol);
  if (version === CAUSAL_PROTOCOL_VERSION_V2) return verifyCommittedCausalProtocolV2(protocol);
  if (version === CAUSAL_PROTOCOL_VERSION) {
    try {
      return verifyCommittedCausalProtocolV1(protocol as CommittedCausalStudyProtocol);
    } catch {
      return ['committed protocol version 1 is structurally invalid'];
    }
  }
  return invalidProtocolRoot(protocol, 'committed protocol');
}

/** V1 is retained for inspection only; only a fully valid v2 commitment may mutate. */
export function isCausalProtocolMutationEligible(protocol: unknown): boolean {
  return runtimeProtocolVersion(protocol) === CAUSAL_PROTOCOL_VERSION_V2
    && verifyCommittedCausalProtocolV2(protocol).length === 0;
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

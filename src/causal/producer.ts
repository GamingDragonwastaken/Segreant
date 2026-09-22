/**
 * Independent, local causal-unit identity production.
 *
 * The retained V2 assignment/lineage validator can prove that an asserted
 * scalar identity is internally consistent.  It cannot, by itself, derive
 * the identity of the work unit that produced a request set.  This module is
 * the deliberately small producer boundary for that missing step.
 *
 * It consumes only authenticated causal records plus a caller-supplied,
 * scalar-only snapshot of retained request, scope, and realization rows.  The
 * unit digest is derived from stable request identity metadata; outcome values
 * and cost scalars are checked as eligibility evidence but are deliberately not
 * inputs to the unit identity.  No prompt, source text, output, credential, or
 * realization unit JSON is accepted.  A receipt is an independently derived
 * identity artifact, not a causal effect, value, invoice, or routing claim.
 */

import {
  causalRealizationSnapshotDigestV2,
  causalRequestPricingDigestV2,
} from '../store/causalLineage.ts';
import {
  canonicalJson,
  isCausalIdentifier,
  sha256,
  verifyCommittedCausalProtocol,
} from './protocol.ts';
import {
  decodeCausalExecutionV2,
  decodeCausalTerminalOutcomeV2,
} from './records.ts';
import type {
  CausalDecisionRecordV2,
  CausalExecutionRecordV2,
  CausalTerminalOutcomeRecordV2,
  CommittedCausalStudyProtocolV2,
} from './types.ts';

export const CAUSAL_PRODUCER_TYPE = 'fiscus.causal-producer-receipt' as const;
export const CAUSAL_PRODUCER_VERSION = 1 as const;
export const CAUSAL_PRODUCER_ID = 'producer:fiscus-local-v1' as const;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_SAFE_MICROS = Number.MAX_SAFE_INTEGER;
const FORBIDDEN_KEYS = new Set([
  'prompt', 'rawPrompt', 'source', 'sourceText', 'unitJson', 'unit_json',
  'output', 'rawOutput', 'credential', 'credentials', 'apiKey', 'token',
]);

const INPUT_KEYS = [
  'protocol', 'decision', 'execution', 'outcome', 'requests', 'scope',
  'realization', 'sequence', 'previousReceiptHash',
] as const;
const SCOPE_KEYS = ['declarationId', 'provider', 'projectRef', 'trust'] as const;
const REQUEST_KEYS = [
  'requestId', 'tsEpochMs', 'provider', 'model', 'project', 'costMicros',
  'estimated', 'via', 'costBasis', 'rateCardSha256', 'rateCardSourceKind',
  'rateMatchKind', 'rateMatchProvider', 'rateMatchModel',
  'scopeCaptureStatus', 'providerScopeDeclarationId',
] as const;
const REALIZATION_KEYS = [
  'commitHash', 'project', 'tsEpochMs', 'computedAtMs', 'attributedCostUsd',
  'maturing', 'realized', 'costScope', 'costStale',
] as const;
const DECISION_KEYS = [
  'type', 'version', 'decisionId', 'studyId', 'blockId', 'protocolHash',
  'blockSequence', 'decisionIndex', 'unitIdDigest', 'assignedAtMs',
  'assignedArmId', 'propensity', 'blockRoot', 'planHash', 'allocationHash',
  'randomizationMaterialDigest', 'previousEventHash', 'eventHash',
] as const;
const RECEIPT_BODY_KEYS = [
  'type', 'version', 'producerId', 'sequence', 'studyId', 'protocolHash',
  'decisionId', 'executionId', 'outcomeId', 'requestIds', 'derivedUnitIdDigest',
  'assignedUnitIdDigest', 'identityRelation', 'requestCount', 'requestCostMicros',
  'requestEvidenceDigest', 'scopeDeclarationId', 'scopeProvider',
  'scopeProjectRef', 'realizationCommitHash', 'realizationSnapshotDigest',
  'outcomeEvidenceDigest', 'ordinaryLedgerVerification', 'previousReceiptHash',
  'producedAtMs', 'claimStatus',
] as const;
const RECEIPT_KEYS = [...RECEIPT_BODY_KEYS, 'receiptHash'] as const;

export interface CausalProducerScopeSnapshotV1 {
  declarationId: string;
  /** Provider key from the locally retained scope declaration, e.g. `openai`. */
  provider: string;
  projectRef: string;
  trust: 'operator_declared_unverified';
}

/**
 * Scalar request projection needed by the producer.  This is intentionally
 * narrower than RequestRow: token counts, cwd, user attribution, and content
 * fields are not part of the producer contract.
 */
export interface CausalProducerRequestSnapshotV1 {
  requestId: string;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  costMicros: number;
  estimated: false;
  via: 'proxy';
  costBasis: 'tool_reported_unverified';
  rateCardSha256: null;
  rateCardSourceKind: 'none';
  rateMatchKind: 'reported';
  rateMatchProvider: null;
  rateMatchModel: null;
  scopeCaptureStatus: 'declared_unverified';
  providerScopeDeclarationId: string;
}

/** Scalar realization projection; unit JSON is intentionally not a field. */
export interface CausalProducerRealizationSnapshotV1 {
  commitHash: string;
  project: string;
  tsEpochMs: number;
  computedAtMs: number;
  attributedCostUsd: number;
  maturing: boolean;
  realized: boolean;
  costScope: 'project' | 'window';
  costStale: boolean;
}

export interface CausalProducerInputV1 {
  protocol: CommittedCausalStudyProtocolV2;
  decision: CausalDecisionRecordV2;
  execution: CausalExecutionRecordV2;
  outcome: CausalTerminalOutcomeRecordV2;
  requests: readonly CausalProducerRequestSnapshotV1[];
  scope: CausalProducerScopeSnapshotV1;
  realization: CausalProducerRealizationSnapshotV1;
  sequence: number;
  previousReceiptHash: string | null;
}

export type CausalProducerReasonCode =
  | 'input_shape_invalid'
  | 'forbidden_input_field'
  | 'protocol_invalid'
  | 'decision_invalid'
  | 'decision_lineage_invalid'
  | 'execution_invalid'
  | 'execution_lineage_invalid'
  | 'outcome_invalid'
  | 'outcome_lineage_invalid'
  | 'outcome_not_mature'
  | 'request_set_invalid'
  | 'request_cost_insufficient'
  | 'request_scope_insufficient'
  | 'request_lineage_invalid'
  | 'request_total_cost_mismatch'
  | 'request_pricing_lineage_invalid'
  | 'realization_invalid'
  | 'realization_not_mature'
  | 'receipt_sequence_invalid'
  | 'assigned_identity_mismatch';

export interface CausalProducerReceiptV1 {
  type: typeof CAUSAL_PRODUCER_TYPE;
  version: typeof CAUSAL_PRODUCER_VERSION;
  producerId: typeof CAUSAL_PRODUCER_ID;
  sequence: number;
  studyId: string;
  protocolHash: string;
  decisionId: string;
  executionId: string;
  outcomeId: string;
  requestIds: string[];
  derivedUnitIdDigest: string;
  assignedUnitIdDigest: string;
  identityRelation: 'matched';
  requestCount: number;
  requestCostMicros: number;
  requestEvidenceDigest: string;
  scopeDeclarationId: string;
  scopeProvider: string;
  scopeProjectRef: string;
  realizationCommitHash: string;
  realizationSnapshotDigest: string;
  outcomeEvidenceDigest: string;
  ordinaryLedgerVerification: 'unresolved';
  previousReceiptHash: string | null;
  producedAtMs: number;
  claimStatus: 'not_established';
  receiptHash: string;
}

export interface CausalProducerAssessmentV1 {
  state: 'produced' | 'inconclusive' | 'invalid';
  reasonCodes: CausalProducerReasonCode[];
  derivedUnitIdDigest: string | null;
  assignedUnitIdDigest: string | null;
  identityRelation: 'matched' | 'mismatched' | 'not_compared';
  receipt: CausalProducerReceiptV1 | null;
  limitations: string[];
}

const LIMITATIONS = [
  'The derived identity is an independently computed local join key, not a causal effect or realized-value claim.',
  'Request scope is operator-declared and does not establish provider-account, invoice, or completeness truth.',
  'The retained ordinary-ledger verifier is unresolved; provider-billed completeness is not established.',
  'Receipt persistence and cross-receipt append-only replay remain Store integration responsibilities.',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!isRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
        || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

/** Reject raw-content fields without reading accessor values. */
function containsForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
  try {
    if (typeof value !== 'object' || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string' && FORBIDDEN_KEYS.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor && containsForbiddenKey(descriptor.value, seen)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function denseArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeSequence(value: unknown): value is number {
  return safeEpoch(value);
}

function safeDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function safeIdentifier(value: unknown): value is string {
  return isCausalIdentifier(value);
}

function safeNonNegativeMicros(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_SAFE_MICROS;
}

function micros(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 1_000_000);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function providerKey(value: string): string {
  return value.startsWith('provider:') ? value.slice('provider:'.length) : value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
    && new Set(values).size === values.length;
}

function domainHash(domain: string, version: number, material: unknown): string {
  return 'sha256:' + sha256(domain + '\n' + String(version) + '\n' + canonicalJson(material));
}

function decisionHash(decision: CausalDecisionRecordV2): string {
  const { eventHash: _ignored, ...material } = decision;
  return domainHash('fiscus.causal.decision', 2, material);
}

function expectedDecisionId(decision: CausalDecisionRecordV2): string {
  return 'decision:' + sha256(canonicalJson({
    domain: 'fiscus.causal.decision-id',
    version: 1,
    studyId: decision.studyId,
    protocolHash: decision.protocolHash,
    blockId: decision.blockId,
    blockSequence: decision.blockSequence,
    decisionIndex: decision.decisionIndex,
    unitIdDigest: decision.unitIdDigest,
  }));
}

function parseScope(value: unknown): CausalProducerScopeSnapshotV1 | null {
  const record = exactDataRecord(value, SCOPE_KEYS);
  if (!record
      || !safeIdentifier(record.declarationId)
      || !safeIdentifier(record.provider)
      || !safeIdentifier(record.projectRef)
      || record.trust !== 'operator_declared_unverified') {
    return null;
  }
  return {
    declarationId: record.declarationId,
    provider: record.provider,
    projectRef: record.projectRef,
    trust: record.trust,
  };
}

function parseRequest(value: unknown): CausalProducerRequestSnapshotV1 | null {
  const record = exactDataRecord(value, REQUEST_KEYS);
  if (!record
      || !safeIdentifier(record.requestId)
      || !safeEpoch(record.tsEpochMs)
      || !safeIdentifier(record.provider)
      || !safeIdentifier(record.model)
      || !safeIdentifier(record.project)
      || !safeNonNegativeMicros(record.costMicros)
      || record.estimated !== false
      || record.via !== 'proxy'
      || record.costBasis !== 'tool_reported_unverified'
      || record.rateCardSha256 !== null
      || record.rateCardSourceKind !== 'none'
      || record.rateMatchKind !== 'reported'
      || record.rateMatchProvider !== null
      || record.rateMatchModel !== null
      || record.scopeCaptureStatus !== 'declared_unverified'
      || !safeIdentifier(record.providerScopeDeclarationId)) {
    return null;
  }
  return {
    requestId: record.requestId,
    tsEpochMs: record.tsEpochMs,
    provider: record.provider,
    model: record.model,
    project: record.project,
    costMicros: record.costMicros,
    estimated: false,
    via: 'proxy',
    costBasis: 'tool_reported_unverified',
    rateCardSha256: null,
    rateCardSourceKind: 'none',
    rateMatchKind: 'reported',
    rateMatchProvider: null,
    rateMatchModel: null,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: record.providerScopeDeclarationId,
  };
}

function parseRealization(value: unknown): CausalProducerRealizationSnapshotV1 | null {
  const record = exactDataRecord(value, REALIZATION_KEYS);
  if (!record
      || typeof record.commitHash !== 'string' || !COMMIT_RE.test(record.commitHash)
      || !safeIdentifier(record.project)
      || !safeEpoch(record.tsEpochMs)
      || !safeEpoch(record.computedAtMs)
      || typeof record.attributedCostUsd !== 'number'
      || !Number.isFinite(record.attributedCostUsd)
      || record.attributedCostUsd < 0
      || micros(record.attributedCostUsd) === null
      || typeof record.maturing !== 'boolean'
      || typeof record.realized !== 'boolean'
      || (record.costScope !== 'project' && record.costScope !== 'window')
      || typeof record.costStale !== 'boolean') {
    return null;
  }
  return {
    commitHash: record.commitHash,
    project: record.project,
    tsEpochMs: record.tsEpochMs,
    computedAtMs: record.computedAtMs,
    attributedCostUsd: record.attributedCostUsd,
    maturing: record.maturing,
    realized: record.realized,
    costScope: record.costScope,
    costStale: record.costStale,
  };
}

function parseDecision(value: unknown): CausalDecisionRecordV2 | null {
  const record = exactDataRecord(value, DECISION_KEYS);
  if (!record
      || record.type !== 'fiscus.causal-decision'
      || record.version !== 2
      || !safeIdentifier(record.decisionId)
      || !safeIdentifier(record.studyId)
      || !safeIdentifier(record.blockId)
      || !safeDigest(record.protocolHash)
      || !safeSequence(record.blockSequence)
      || !safeSequence(record.decisionIndex)
      || !safeDigest(record.unitIdDigest)
      || !safeEpoch(record.assignedAtMs)
      || !safeIdentifier(record.assignedArmId)
      || record.propensity !== 0.5
      || !safeDigest(record.blockRoot)
      || !safeDigest(record.planHash)
      || !safeDigest(record.allocationHash)
      || !safeDigest(record.randomizationMaterialDigest)
      || !safeDigest(record.previousEventHash)
      || !safeDigest(record.eventHash)) {
    return null;
  }
  const decision = {
    type: record.type,
    version: record.version,
    decisionId: record.decisionId,
    studyId: record.studyId,
    blockId: record.blockId,
    protocolHash: record.protocolHash,
    blockSequence: record.blockSequence,
    decisionIndex: record.decisionIndex,
    unitIdDigest: record.unitIdDigest,
    assignedAtMs: record.assignedAtMs,
    assignedArmId: record.assignedArmId,
    propensity: record.propensity,
    blockRoot: record.blockRoot,
    planHash: record.planHash,
    allocationHash: record.allocationHash,
    randomizationMaterialDigest: record.randomizationMaterialDigest,
    previousEventHash: record.previousEventHash,
    eventHash: record.eventHash,
  } as CausalDecisionRecordV2;
  return decisionHash(decision) === decision.eventHash ? decision : null;
}

function parseRoot(value: unknown): Record<string, unknown> | null {
  return exactDataRecord(value, INPUT_KEYS);
}

function requestIdentityMaterial(
  protocol: CommittedCausalStudyProtocolV2,
  scope: CausalProducerScopeSnapshotV1,
  requests: readonly CausalProducerRequestSnapshotV1[],
): Record<string, unknown> {
  return {
    type: 'fiscus.causal-producer-unit-identity',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    scope: {
      declarationId: scope.declarationId,
      provider: scope.provider,
      projectRef: scope.projectRef,
      trust: scope.trust,
    },
    requestIdentity: requests.map((request) => ({
      requestId: request.requestId,
      tsEpochMs: request.tsEpochMs,
      provider: request.provider,
      model: request.model,
      project: request.project,
      providerScopeDeclarationId: request.providerScopeDeclarationId,
    })),
  };
}

function requestEvidenceMaterial(
  protocol: CommittedCausalStudyProtocolV2,
  scope: CausalProducerScopeSnapshotV1,
  requests: readonly CausalProducerRequestSnapshotV1[],
  pricingDigests: readonly string[],
  totalCostMicros: number,
): Record<string, unknown> {
  return {
    type: 'fiscus.causal-producer-request-evidence',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    scope: {
      declarationId: scope.declarationId,
      provider: scope.provider,
      projectRef: scope.projectRef,
      trust: scope.trust,
    },
    requests: requests.map((request, index) => ({
      requestId: request.requestId,
      tsEpochMs: request.tsEpochMs,
      provider: request.provider,
      model: request.model,
      project: request.project,
      costMicros: request.costMicros,
      pricingDigest: pricingDigests[index]!,
    })),
    totalCostMicros,
  };
}

function outcomeEvidenceMaterial(
  outcome: CausalTerminalOutcomeRecordV2,
): Record<string, unknown> {
  return {
    type: outcome.type,
    version: outcome.version,
    outcomeId: outcome.outcomeId,
    decisionId: outcome.decisionId,
    studyId: outcome.studyId,
    protocolHash: outcome.protocolHash,
    observedAtMs: outcome.observedAtMs,
    maturity: outcome.maturity,
    qualityValue: outcome.qualityValue,
    qualityEvidenceClass: outcome.qualityEvidenceClass,
    economicValueUsd: outcome.economicValueUsd,
    economicEvidenceClass: outcome.economicEvidenceClass,
    outcomeEvidenceDigests: [...outcome.outcomeEvidenceDigests],
    censoredReason: outcome.censoredReason,
    invalidReason: outcome.invalidReason,
    previousEventHash: outcome.previousEventHash,
    eventHash: outcome.eventHash,
  };
}

function receiptHash(material: Omit<CausalProducerReceiptV1, 'receiptHash'>): string {
  return domainHash('fiscus.causal.producer-receipt', CAUSAL_PRODUCER_VERSION, material);
}

function invalidAssessment(
  reasonCodes: CausalProducerReasonCode[],
  assignedUnitIdDigest: string | null = null,
  derivedUnitIdDigest: string | null = null,
  identityRelation: CausalProducerAssessmentV1['identityRelation'] = 'not_compared',
  state: 'invalid' | 'inconclusive' = 'invalid',
): CausalProducerAssessmentV1 {
  return {
    state,
    reasonCodes: [...new Set(reasonCodes)],
    derivedUnitIdDigest,
    assignedUnitIdDigest,
    identityRelation,
    receipt: null,
    limitations: [...LIMITATIONS],
  };
}

/**
 * Derive and emit one local causal-unit receipt.  Any incomplete or
 * contradictory scalar evidence returns a bounded non-produced assessment;
 * no digest is usable for a causal join until the state is `produced`.
 */
export function produceCausalUnitReceiptV1(value: unknown): CausalProducerAssessmentV1 {
  try {
    const root = parseRoot(value);
    if (!root) return invalidAssessment(['input_shape_invalid']);
    if (containsForbiddenKey(value)) return invalidAssessment(['forbidden_input_field']);

    let protocol: CommittedCausalStudyProtocolV2;
    try {
      if (!isRecord(root.protocol)
          || root.protocol.version !== 2
          || verifyCommittedCausalProtocol(root.protocol).length > 0) {
        return invalidAssessment(['protocol_invalid']);
      }
      protocol = root.protocol as unknown as CommittedCausalStudyProtocolV2;
    } catch {
      return invalidAssessment(['protocol_invalid']);
    }

    const decision = parseDecision(root.decision);
    if (!decision) return invalidAssessment(['decision_invalid']);
    const assignedUnitIdDigest = decision.unitIdDigest;
    if (decision.studyId !== protocol.studyId
        || decision.protocolHash !== protocol.protocolHash
        || decision.decisionId !== expectedDecisionId(decision)) {
      return invalidAssessment(['decision_lineage_invalid'], assignedUnitIdDigest);
    }
    if (decision.assignedAtMs < protocol.studyWindow.startsAtMs
        || (protocol.studyWindow.endsAtMs !== null && decision.assignedAtMs > protocol.studyWindow.endsAtMs)) {
      return invalidAssessment(['decision_lineage_invalid'], assignedUnitIdDigest);
    }
    const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId);
    if (!arm || arm.providerId === null || arm.modelId === null) {
      return invalidAssessment(['decision_lineage_invalid'], assignedUnitIdDigest);
    }

    let execution: CausalExecutionRecordV2;
    try {
      execution = decodeCausalExecutionV2(root.execution);
    } catch {
      return invalidAssessment(['execution_invalid'], assignedUnitIdDigest);
    }
    if (execution.studyId !== protocol.studyId
        || execution.protocolHash !== protocol.protocolHash
        || execution.decisionId !== decision.decisionId
        || execution.previousEventHash !== decision.eventHash
        || execution.startedAtMs < decision.assignedAtMs
        || execution.completedAtMs < execution.startedAtMs
        || execution.startedAtMs < protocol.studyWindow.startsAtMs
        || (protocol.studyWindow.endsAtMs !== null && execution.completedAtMs > protocol.studyWindow.endsAtMs)
        || execution.assignedExecutionPlanDigest !== arm.executionPlanDigest
        || execution.actualExecutionPlanDigest !== arm.executionPlanDigest
        || execution.adherence !== 'confirmed') {
      return invalidAssessment(['execution_lineage_invalid'], assignedUnitIdDigest);
    }
    const directCostMicros = micros(execution.directAiCostUsd);
    if (directCostMicros === null
        || !protocol.costOutcome.acceptedSourceClasses.includes(
          execution.directCostSourceClass as 'actual_observed' | 'actual_reconciled',
        )
        || execution.directAiCostUsd === null
        || execution.directAiCostUsd < protocol.costOutcome.boundsUsd.low
        || execution.directAiCostUsd > protocol.costOutcome.boundsUsd.high) {
      return invalidAssessment(
        ['request_cost_insufficient'],
        assignedUnitIdDigest,
        null,
        'not_compared',
        'inconclusive',
      );
    }
    if (protocol.question === 'model_cost_quality') {
      if (execution.fullArmCostUsd !== null || execution.fullCostSourceClass !== 'incomplete_or_unknown') {
        return invalidAssessment(['execution_lineage_invalid'], assignedUnitIdDigest);
      }
    } else if (execution.fullArmCostUsd === null
        || !protocol.costOutcome.acceptedSourceClasses.includes(
          execution.fullCostSourceClass as 'actual_observed' | 'actual_reconciled',
        )
        || execution.fullArmCostUsd < protocol.costOutcome.boundsUsd.low
        || execution.fullArmCostUsd > protocol.costOutcome.boundsUsd.high) {
      return invalidAssessment(['request_cost_insufficient'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');
    }

    let outcome: CausalTerminalOutcomeRecordV2;
    try {
      outcome = decodeCausalTerminalOutcomeV2(root.outcome);
    } catch {
      return invalidAssessment(['outcome_invalid'], assignedUnitIdDigest);
    }
    if (outcome.studyId !== protocol.studyId
        || outcome.protocolHash !== protocol.protocolHash
        || outcome.decisionId !== decision.decisionId
        || outcome.previousEventHash !== execution.eventHash
        || outcome.observedAtMs < execution.completedAtMs) {
      return invalidAssessment(['outcome_lineage_invalid'], assignedUnitIdDigest);
    }
    if (outcome.maturity !== 'matured') {
      return invalidAssessment(
        ['outcome_not_mature'],
        assignedUnitIdDigest,
        null,
        'not_compared',
        'inconclusive',
      );
    }
    if (outcome.qualityValue === null
        || outcome.qualityValue < protocol.qualityOutcome.bounds.low
        || outcome.qualityValue > protocol.qualityOutcome.bounds.high
        || outcome.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass
        || outcome.outcomeEvidenceDigests.length === 0) {
      return invalidAssessment(['outcome_not_mature'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');
    }
    if (protocol.question === 'model_cost_quality') {
      if (protocol.economicOutcome !== null
          || outcome.economicValueUsd !== null
          || outcome.economicEvidenceClass !== null) {
        return invalidAssessment(['outcome_lineage_invalid'], assignedUnitIdDigest);
      }
    } else {
      const economic = protocol.economicOutcome;
      if (!economic
          || outcome.economicValueUsd === null
          || outcome.economicValueUsd < economic.boundsUsd.low
          || outcome.economicValueUsd > economic.boundsUsd.high
          || outcome.economicEvidenceClass !== economic.evidenceClass) {
        return invalidAssessment(['outcome_not_mature'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');
      }
    }

    const scope = parseScope(root.scope);
    if (!scope) return invalidAssessment(['request_scope_insufficient'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');

    if (!denseArray(root.requests) || root.requests.length === 0) {
      return invalidAssessment(['request_set_invalid'], assignedUnitIdDigest);
    }
    const requests: CausalProducerRequestSnapshotV1[] = [];
    for (const rawRequest of root.requests) {
      const request = parseRequest(rawRequest);
      if (!request) return invalidAssessment(['request_set_invalid'], assignedUnitIdDigest);
      requests.push(request);
    }
    requests.sort((left, right) => compareIds(left.requestId, right.requestId));
    if (!uniqueSorted(requests.map((request) => request.requestId))
        || !sameStrings(requests.map((request) => request.requestId), execution.requestIds)) {
      return invalidAssessment(['request_lineage_invalid'], assignedUnitIdDigest);
    }

    let totalCostMicros = 0;
    const pricingDigests: string[] = [];
    for (const request of requests) {
      if (request.tsEpochMs < execution.startedAtMs || request.tsEpochMs > execution.completedAtMs
          || request.provider !== arm.providerId
          || request.model !== arm.modelId) {
        return invalidAssessment(['request_lineage_invalid'], assignedUnitIdDigest);
      }
      if (request.providerScopeDeclarationId !== scope.declarationId
          || providerKey(request.provider) !== scope.provider
          || request.project !== scope.projectRef) {
        return invalidAssessment(['request_scope_insufficient'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');
      }
      if (totalCostMicros > MAX_SAFE_MICROS - request.costMicros) {
        return invalidAssessment(['request_cost_insufficient'], assignedUnitIdDigest, null, 'not_compared', 'inconclusive');
      }
      totalCostMicros += request.costMicros;
      try {
        pricingDigests.push(causalRequestPricingDigestV2({
          requestId: request.requestId,
          tsEpochMs: request.tsEpochMs,
          provider: request.provider,
          model: request.model,
          project: request.project,
          costMicros: request.costMicros,
          costBasis: request.costBasis,
          rateCardSha256: request.rateCardSha256,
          rateCardSourceKind: request.rateCardSourceKind,
          rateMatchKind: request.rateMatchKind,
          rateMatchProvider: request.rateMatchProvider,
          rateMatchModel: request.rateMatchModel,
          scopeCaptureStatus: request.scopeCaptureStatus,
          providerScopeDeclarationId: request.providerScopeDeclarationId,
        }));
      } catch {
        return invalidAssessment(['request_pricing_lineage_invalid'], assignedUnitIdDigest);
      }
    }
    if (totalCostMicros !== directCostMicros) {
      return invalidAssessment(['request_total_cost_mismatch'], assignedUnitIdDigest);
    }
    const sortedPricingDigests = [...pricingDigests].sort();
    if (!sameStrings(sortedPricingDigests, [...execution.priceLineageDigests].sort())) {
      return invalidAssessment(['request_pricing_lineage_invalid'], assignedUnitIdDigest);
    }

    const realization = parseRealization(root.realization);
    if (!realization) return invalidAssessment(['realization_invalid'], assignedUnitIdDigest);
    if (realization.project !== scope.projectRef
        || realization.tsEpochMs < execution.completedAtMs
        || realization.computedAtMs < realization.tsEpochMs
        || realization.computedAtMs < execution.completedAtMs) {
      return invalidAssessment(['realization_invalid'], assignedUnitIdDigest);
    }
    if (realization.maturing || !realization.realized || realization.costStale) {
      return invalidAssessment(
        ['realization_not_mature'],
        assignedUnitIdDigest,
        null,
        'not_compared',
        'inconclusive',
      );
    }

    const identityMaterial = requestIdentityMaterial(protocol, scope, requests);
    const derivedUnitIdDigest = domainHash('fiscus.causal.producer-unit', CAUSAL_PRODUCER_VERSION, identityMaterial);
    if (derivedUnitIdDigest !== assignedUnitIdDigest) {
      return invalidAssessment(
        ['assigned_identity_mismatch'],
        assignedUnitIdDigest,
        derivedUnitIdDigest,
        'mismatched',
      );
    }

    const requestEvidenceDigest = domainHash(
      'fiscus.causal.producer-request-evidence',
      CAUSAL_PRODUCER_VERSION,
      requestEvidenceMaterial(protocol, scope, requests, pricingDigests, totalCostMicros),
    );
    let realizationSnapshotDigest: string;
    try {
      realizationSnapshotDigest = causalRealizationSnapshotDigestV2({
        commitHash: realization.commitHash,
        project: realization.project,
        tsEpochMs: realization.tsEpochMs,
        computedAtMs: realization.computedAtMs,
        attributedCostUsd: realization.attributedCostUsd,
        maturing: realization.maturing,
        realized: realization.realized,
        costScope: realization.costScope,
        costStale: realization.costStale,
      });
    } catch {
      return invalidAssessment(['realization_invalid'], assignedUnitIdDigest);
    }
    const outcomeEvidenceDigest = domainHash(
      'fiscus.causal.producer-outcome-evidence',
      CAUSAL_PRODUCER_VERSION,
      outcomeEvidenceMaterial(outcome),
    );
    const sequenceValue = root.sequence;
    const previousReceiptHashValue = root.previousReceiptHash;
    if (!safeSequence(sequenceValue)
        || (sequenceValue === 1 && previousReceiptHashValue !== null)
        || (sequenceValue > 1 && !safeDigest(previousReceiptHashValue))) {
      return invalidAssessment(['receipt_sequence_invalid'], assignedUnitIdDigest);
    }
    const sequence = sequenceValue;
    const previousReceiptHash = previousReceiptHashValue as string | null;

    const body: Omit<CausalProducerReceiptV1, 'receiptHash'> = {
      type: CAUSAL_PRODUCER_TYPE,
      version: CAUSAL_PRODUCER_VERSION,
      producerId: CAUSAL_PRODUCER_ID,
      sequence,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      decisionId: decision.decisionId,
      executionId: execution.executionId,
      outcomeId: outcome.outcomeId,
      requestIds: requests.map((request) => request.requestId),
      derivedUnitIdDigest,
      assignedUnitIdDigest,
      identityRelation: 'matched',
      requestCount: requests.length,
      requestCostMicros: totalCostMicros,
      requestEvidenceDigest,
      scopeDeclarationId: scope.declarationId,
      scopeProvider: scope.provider,
      scopeProjectRef: scope.projectRef,
      realizationCommitHash: realization.commitHash,
      realizationSnapshotDigest,
      outcomeEvidenceDigest,
      ordinaryLedgerVerification: 'unresolved',
      previousReceiptHash,
      producedAtMs: outcome.observedAtMs,
      claimStatus: 'not_established',
    };
    const receipt: CausalProducerReceiptV1 = Object.freeze({
      ...body,
      requestIds: Object.freeze([...body.requestIds]),
      receiptHash: receiptHash(body),
    }) as unknown as CausalProducerReceiptV1;
    return {
      state: 'produced',
      reasonCodes: [],
      derivedUnitIdDigest,
      assignedUnitIdDigest,
      identityRelation: 'matched',
      receipt,
      limitations: [...LIMITATIONS],
    };
  } catch {
    return invalidAssessment(['input_shape_invalid']);
  }
}

function parseReceipt(value: unknown): CausalProducerReceiptV1 | null {
  const record = exactDataRecord(value, RECEIPT_KEYS);
  if (!record
      || record.type !== CAUSAL_PRODUCER_TYPE
      || record.version !== CAUSAL_PRODUCER_VERSION
      || record.producerId !== CAUSAL_PRODUCER_ID
      || !safeSequence(record.sequence)
      || !safeIdentifier(record.studyId)
      || !safeDigest(record.protocolHash)
      || !safeIdentifier(record.decisionId)
      || !safeIdentifier(record.executionId)
      || !safeIdentifier(record.outcomeId)
      || !denseArray(record.requestIds)
      || record.requestIds.length === 0
      || !record.requestIds.every(safeIdentifier)
      || !uniqueSorted(record.requestIds)
      || !safeDigest(record.derivedUnitIdDigest)
      || !safeDigest(record.assignedUnitIdDigest)
      || record.derivedUnitIdDigest !== record.assignedUnitIdDigest
      || record.identityRelation !== 'matched'
      || !Number.isSafeInteger(record.requestCount)
      || record.requestCount !== record.requestIds.length
      || !safeNonNegativeMicros(record.requestCostMicros)
      || !safeDigest(record.requestEvidenceDigest)
      || !safeIdentifier(record.scopeDeclarationId)
      || !safeIdentifier(record.scopeProvider)
      || !safeIdentifier(record.scopeProjectRef)
      || typeof record.realizationCommitHash !== 'string'
      || !COMMIT_RE.test(record.realizationCommitHash)
      || !safeDigest(record.realizationSnapshotDigest)
      || !safeDigest(record.outcomeEvidenceDigest)
      || record.ordinaryLedgerVerification !== 'unresolved'
      || (record.previousReceiptHash !== null && !safeDigest(record.previousReceiptHash))
      || (record.sequence === 1 && record.previousReceiptHash !== null)
      || (record.sequence > 1 && !safeDigest(record.previousReceiptHash))
      || !safeEpoch(record.producedAtMs)
      || record.claimStatus !== 'not_established'
      || !safeDigest(record.receiptHash)) {
    return null;
  }
  return {
    type: CAUSAL_PRODUCER_TYPE,
    version: CAUSAL_PRODUCER_VERSION,
    producerId: CAUSAL_PRODUCER_ID,
    sequence: record.sequence,
    studyId: record.studyId,
    protocolHash: record.protocolHash,
    decisionId: record.decisionId,
    executionId: record.executionId,
    outcomeId: record.outcomeId,
    requestIds: [...record.requestIds],
    derivedUnitIdDigest: record.derivedUnitIdDigest,
    assignedUnitIdDigest: record.assignedUnitIdDigest,
    identityRelation: 'matched',
    requestCount: record.requestCount,
    requestCostMicros: record.requestCostMicros,
    requestEvidenceDigest: record.requestEvidenceDigest,
    scopeDeclarationId: record.scopeDeclarationId,
    scopeProvider: record.scopeProvider,
    scopeProjectRef: record.scopeProjectRef,
    realizationCommitHash: record.realizationCommitHash,
    realizationSnapshotDigest: record.realizationSnapshotDigest,
    outcomeEvidenceDigest: record.outcomeEvidenceDigest,
    ordinaryLedgerVerification: 'unresolved',
    previousReceiptHash: record.previousReceiptHash,
    producedAtMs: record.producedAtMs,
    claimStatus: 'not_established',
    receiptHash: record.receiptHash,
  };
}

/** Verify a receipt without exposing arbitrary input errors or raw content. */
export function verifyCausalProducerReceiptV1(value: unknown): string[] {
  try {
    if (containsForbiddenKey(value)) return ['forbidden_input_field'];
    const receipt = parseReceipt(value);
    if (!receipt) return ['receipt_shape_invalid'];
    const { receiptHash: _ignored, ...body } = receipt;
    return receiptHash(body) === receipt.receiptHash ? [] : ['receipt_hash_mismatch'];
  } catch {
    return ['receipt_shape_invalid'];
  }
}

/** Recompute the domain-separated receipt hash for an already typed body. */
export function causalProducerReceiptHashV1(
  material: Omit<CausalProducerReceiptV1, 'receiptHash'>,
): string {
  return receiptHash(material);
}

/** Stable source-free hash of the producer's identity material for diagnostics. */
export function causalProducerIdentityMaterialDigestV1(
  protocol: CommittedCausalStudyProtocolV2,
  scope: CausalProducerScopeSnapshotV1,
  requests: readonly CausalProducerRequestSnapshotV1[],
): string {
  return domainHash(
    'fiscus.causal.producer-unit',
    CAUSAL_PRODUCER_VERSION,
    requestIdentityMaterial(protocol, scope, [...requests].sort((left, right) => compareIds(left.requestId, right.requestId))),
  );
}

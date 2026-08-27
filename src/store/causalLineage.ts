/**
 * Store-internal T-069 lineage resolver.
 *
 * This module owns the Store-internal T-069 scalar sidecar boundary.  It
 * validates a proposed, minimal binding against the already-retained V2
 * causal records, request ledger, and scalar realization snapshot, then
 * persists only its canonical scalar envelope behind the exact schema and
 * append-only trigger authority.  It never selects or accepts prompts, source
 * text, or realization `unit_json`.
 *
 * The binding and all derived digests contain identifiers and scalar metadata
 * only.  Raw prompts, source text, and realization `unit_json` are neither
 * accepted by the input shape nor selected from SQLite.
 */

import type { DatabaseSync } from 'node:sqlite';
import { decodeCausalExecutionV2, decodeCausalTerminalOutcomeV2 } from '../causal/records.ts';
import {
  canonicalJson,
  isCausalIdentifier,
  isSha256,
  sha256,
  verifyCommittedCausalProtocol,
} from '../causal/protocol.ts';
import type { CausalExecutionRecordV2, CausalTerminalOutcomeRecordV2, CommittedCausalStudyProtocolV2 } from '../causal/types.ts';
import { causalV2SchemaComplete } from './schema.ts';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_SAFE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const FORBIDDEN_KEYS = new Set(['prompt', 'rawPrompt', 'source', 'sourceText', 'unitJson', 'unit_json']);

const BINDING_KEYS = [
  'type', 'version', 'bindingId', 'studyId', 'protocolHash', 'decisionId', 'executionId', 'outcomeId',
  'unitIdDigest', 'requestIds', 'realizationCommitHash', 'realizationSnapshotDigest',
] as const;

const BINDING_WITH_DIGEST_KEYS = [...BINDING_KEYS, 'bindingDigest'] as const;

type BindingMaterial = {
  type: 'fiscus.causal-lineage-binding';
  version: 2;
  bindingId: string;
  studyId: string;
  protocolHash: string;
  decisionId: string;
  executionId: string;
  outcomeId: string;
  unitIdDigest: string;
  requestIds: string[];
  realizationCommitHash: string;
  realizationSnapshotDigest: string;
};

export type CausalLineageBindingV2 = BindingMaterial & { bindingDigest: string };

export type CausalLineageReasonCode =
  | 'binding_shape_invalid'
  | 'binding_digest_mismatch'
  | 'causal_schema_unavailable'
  | 'study_missing'
  | 'protocol_identity_mismatch'
  | 'decision_missing'
  | 'decision_identity_mismatch'
  | 'execution_missing'
  | 'execution_identity_mismatch'
  | 'ledger_verification_unresolved'
  | 'request_ids_mismatch'
  | 'request_missing'
  | 'request_scope_unresolved'
  | 'request_provider_mismatch'
  | 'request_model_mismatch'
  | 'request_cost_evidence_unaccepted'
  | 'request_cost_scalar_mismatch'
  | 'request_price_lineage_mismatch'
  | 'outcome_missing'
  | 'outcome_identity_mismatch'
  | 'outcome_not_mature'
  | 'realization_missing'
  | 'realization_not_mature'
  | 'realization_scope_invalid'
  | 'realization_project_mismatch'
  | 'realization_snapshot_digest_mismatch';

/** Qualification must not report a cost-bearing V2 result as qualified until
 * the durable sidecar is available.  The schema-backed append slice is next. */
export const CAUSAL_LINEAGE_BINDING_NOT_PERSISTED =
  'V2 request-to-realization lineage binding is not persisted';
export const CAUSAL_LINEAGE_BINDING_INVALID =
  'V2 request-to-realization lineage binding failed validation';

export interface CausalLineageBindingValidationV2 {
  state: 'valid' | 'invalid';
  reasonCodes: CausalLineageReasonCode[];
  /** The candidate's digest is retained in the result without retaining prompts/source. */
  bindingDigest: string | null;
  requestCount: number;
  actualCostUsd: number | null;
  realizationSnapshotDigest: string | null;
}

export interface CausalRequestPricingDigestInputV2 {
  requestId: string;
  tsEpochMs: number;
  provider: string;
  model: string;
  project: string;
  costMicros: number;
  costBasis: 'tool_reported_unverified';
  rateCardSha256: null;
  rateCardSourceKind: 'none';
  rateMatchKind: 'reported';
  rateMatchProvider: null;
  rateMatchModel: null;
  scopeCaptureStatus: 'declared_unverified';
  providerScopeDeclarationId: string;
}

export interface CausalRealizationSnapshotInputV2 {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function canonicalBindingMaterial(binding: BindingMaterial): string {
  return canonicalJson(binding);
}

/** Digest used by the future append-only sidecar and by resolver tests. */
export function causalLineageBindingDigestV2(binding: BindingMaterial): string {
  return 'sha256:' + sha256('fiscus.causal.lineage-binding\n2\n' + canonicalBindingMaterial(binding));
}

/**
 * Derive one stable price-lineage digest from the exact retained request
 * scalar fields accepted by this resolver.  It intentionally omits user,
 * cwd, source, prompt, and token text/content fields.
 */
export function causalRequestPricingDigestV2(input: CausalRequestPricingDigestInputV2): string {
  return 'sha256:' + sha256('fiscus.causal.request-cost-lineage\n2\n' + canonicalJson(input));
}

/** Derive the digest for the immutable scalar realization snapshot only. */
export function causalRealizationSnapshotDigestV2(input: CausalRealizationSnapshotInputV2): string {
  return 'sha256:' + sha256('fiscus.causal.realization-snapshot\n2\n' + canonicalJson(input));
}

function validBindingShape(value: unknown): value is CausalLineageBindingV2 {
  try {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) return false;
    const keys = ownKeys as string[];
    if (keys.length !== BINDING_WITH_DIGEST_KEYS.length
        || keys.some((key) => FORBIDDEN_KEYS.has(key)
          || !BINDING_WITH_DIGEST_KEYS.includes(key as typeof BINDING_WITH_DIGEST_KEYS[number]))) {
      return false;
    }
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return false;
      descriptors.set(key, descriptor);
    }
    const requestIds = descriptors.get('requestIds')?.value;
    if (!Array.isArray(requestIds) || Object.getPrototypeOf(requestIds) !== Array.prototype
        || requestIds.length === 0) {
      return false;
    }
    const requestKeys = Reflect.ownKeys(requestIds);
    if (requestKeys.some((key) => typeof key !== 'string')
        || requestKeys.length !== requestIds.length + 1
        || !requestKeys.includes('length')) return false;
    const requestLength = Object.getOwnPropertyDescriptor(requestIds, 'length');
    if (!requestLength || !('value' in requestLength) || requestLength.value !== requestIds.length
        || requestLength.enumerable !== false) return false;
    const requestValues: string[] = [];
    for (let index = 0; index < requestIds.length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(requestIds, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true
          || !isCausalIdentifier(descriptor.value)) return false;
      requestValues.push(descriptor.value);
    }
    if (new Set(requestValues).size !== requestValues.length
        || requestValues.some((id, index) => index > 0 && requestValues[index - 1]! > id)) {
      return false;
    }
    const values = Object.fromEntries([...descriptors.entries()].map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
    const realizationCommitHash = values.realizationCommitHash;
    if (values.type !== 'fiscus.causal-lineage-binding' || values.version !== 2
        || !isCausalIdentifier(values.bindingId) || !isCausalIdentifier(values.studyId)
        || !isDigest(values.protocolHash) || !isCausalIdentifier(values.decisionId)
        || !isCausalIdentifier(values.executionId) || !isCausalIdentifier(values.outcomeId)
        || !isDigest(values.unitIdDigest)
        || typeof realizationCommitHash !== 'string' || !GIT_COMMIT_RE.test(realizationCommitHash)
        || !isDigest(values.realizationSnapshotDigest) || !isDigest(values.bindingDigest)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Copy a candidate through an immutable scalar boundary before any digest or
 * SQLite operation can observe a caller-owned object or mutable request array. */
function immutableBinding(value: unknown): CausalLineageBindingV2 | null {
  if (!validBindingShape(value)) return null;
  try {
    const read = (key: typeof BINDING_WITH_DIGEST_KEYS[number]): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const requestIdsValue = read('requestIds');
    if (!Array.isArray(requestIdsValue)) return null;
    const requestIds: string[] = [];
    for (let index = 0; index < requestIdsValue.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(requestIdsValue, String(index));
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return null;
      requestIds.push(descriptor.value);
    }
    const copy = {
      type: read('type'),
      version: read('version'),
      bindingId: read('bindingId'),
      studyId: read('studyId'),
      protocolHash: read('protocolHash'),
      decisionId: read('decisionId'),
      executionId: read('executionId'),
      outcomeId: read('outcomeId'),
      unitIdDigest: read('unitIdDigest'),
      requestIds: Object.freeze(requestIds),
      realizationCommitHash: read('realizationCommitHash'),
      realizationSnapshotDigest: read('realizationSnapshotDigest'),
      bindingDigest: read('bindingDigest'),
    } as unknown as CausalLineageBindingV2;
    return validBindingShape(copy) ? Object.freeze(copy) : null;
  } catch {
    return null;
  }
}

function invalidResult(
  reasonCodes: CausalLineageReasonCode[],
  bindingDigest: string | null,
  requestCount = 0,
  actualCostUsd: number | null = null,
  realizationSnapshotDigest: string | null = null,
): CausalLineageBindingValidationV2 {
  return {
    state: 'invalid',
    reasonCodes: [...new Set(reasonCodes)],
    bindingDigest,
    requestCount,
    actualCostUsd,
    realizationSnapshotDigest,
  };
}

interface StoredProtocolRow {
  studyId: unknown;
  protocolHash: unknown;
  protocolJson: unknown;
}

interface StoredDecisionRow {
  decisionId: unknown;
  studyId: unknown;
  unitIdDigest: unknown;
  eventHash: unknown;
  decisionJson: unknown;
}

interface StoredExecutionRow {
  executionId: unknown;
  decisionId: unknown;
  studyId: unknown;
  protocolHash: unknown;
  startedAtMs: unknown;
  completedAtMs: unknown;
  eventHash: unknown;
  executionJson: unknown;
}

interface StoredOutcomeRow {
  outcomeId: unknown;
  decisionId: unknown;
  studyId: unknown;
  protocolHash: unknown;
  observedAtMs: unknown;
  maturity: unknown;
  eventHash: unknown;
  terminalOutcomeJson: unknown;
}

interface StoredRequestRow {
  requestId: unknown;
  tsEpochMs: unknown;
  provider: unknown;
  model: unknown;
  project: unknown;
  costUsd: unknown;
  estimated: unknown;
  via: unknown;
  costBasis: unknown;
  rateCardSha256: unknown;
  rateCardSourceKind: unknown;
  rateMatchKind: unknown;
  rateMatchProvider: unknown;
  rateMatchModel: unknown;
  scopeCaptureStatus: unknown;
  providerScopeDeclarationId: unknown;
}

interface StoredScopeDeclarationRow {
  declarationId: unknown;
  provider: unknown;
  providerProjectRef: unknown;
  trust: unknown;
}

interface StoredRealizationRow {
  commitHash: unknown;
  project: unknown;
  tsEpochMs: unknown;
  computedAtMs: unknown;
  attributedCostUsd: unknown;
  maturing: unknown;
  realized: unknown;
  costScope: unknown;
  costStale: unknown;
}

function parseCanonicalJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && canonicalJson(parsed) === raw ? parsed : null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function asPositiveSafeInteger(value: unknown): number | null {
  const integer = asSafeInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

function micros(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const result = Math.round(value * 1_000_000);
  return Number.isSafeInteger(result) ? result : null;
}

function equalRequestIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function inBounds(value: number | null, bounds: { low: number; high: number }): boolean {
  return value !== null && Number.isFinite(value) && value >= bounds.low && value <= bounds.high;
}

function decisionEventHashV2(decision: Record<string, unknown>): string {
  const { eventHash: _ignored, ...material } = decision;
  return 'sha256:' + sha256('fiscus.causal.decision\n2\n' + canonicalJson(material));
}

/** Provider scope declarations currently have a concrete OpenAI key, while
 * committed causal protocols use a namespaced provider id. */
function declaredProviderKey(provider: string): string | null {
  if (provider === 'openai') return provider;
  if (provider === 'provider:openai') return 'openai';
  return null;
}

function emptyBindingDigest(value: unknown): string | null {
  try {
    if (!isRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'bindingDigest');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one proposed T-069 binding against the existing Store records.
 * No write occurs, and malformed/hostile rows return a bounded invalid result.
 */
export function validateCausalLineageBindingV2(
  db: DatabaseSync,
  value: unknown,
): CausalLineageBindingValidationV2 {
  const candidateDigest = emptyBindingDigest(value);
  const binding = immutableBinding(value);
  if (!binding) return invalidResult(['binding_shape_invalid'], candidateDigest);
  if (causalLineageBindingDigestV2({
    type: binding.type,
    version: binding.version,
    bindingId: binding.bindingId,
    studyId: binding.studyId,
    protocolHash: binding.protocolHash,
    decisionId: binding.decisionId,
    executionId: binding.executionId,
    outcomeId: binding.outcomeId,
    unitIdDigest: binding.unitIdDigest,
    requestIds: [...binding.requestIds],
    realizationCommitHash: binding.realizationCommitHash,
    realizationSnapshotDigest: binding.realizationSnapshotDigest,
  }) !== binding.bindingDigest) {
    return invalidResult(['binding_digest_mismatch'], binding.bindingDigest);
  }

  const reasons: CausalLineageReasonCode[] = [];
  let requestCount = 0;
  let actualCostUsd: number | null = null;
  let realizedDigest: string | null = null;
  try {
    const protocolRow = db.prepare(
      `SELECT study_id AS studyId, protocol_hash AS protocolHash, protocol_json AS protocolJson
         FROM causal_protocols WHERE study_id = ?`,
    ).get(binding.studyId) as StoredProtocolRow | undefined;
    if (!protocolRow) return invalidResult(['study_missing'], binding.bindingDigest);
    const protocolRaw = parseCanonicalJson(protocolRow.protocolJson);
    const protocol = protocolRaw as unknown as CommittedCausalStudyProtocolV2 | null;
    if (!protocol || protocol.version !== 2
        || protocolRow.studyId !== binding.studyId || protocolRow.protocolHash !== binding.protocolHash
        || protocol.studyId !== binding.studyId || protocol.protocolHash !== binding.protocolHash
        || verifyCommittedCausalProtocol(protocol).length > 0) {
      reasons.push('protocol_identity_mismatch');
    }
    if (reasons.length > 0) return invalidResult(reasons, binding.bindingDigest);
    if (!protocol) return invalidResult(['protocol_identity_mismatch'], binding.bindingDigest);

    const decisionRow = db.prepare(
      `SELECT decision_id AS decisionId, study_id AS studyId,
              unit_id_digest AS unitIdDigest, event_hash AS eventHash, decision_json AS decisionJson
         FROM causal_decisions_v2 WHERE decision_id = ?`,
    ).get(binding.decisionId) as StoredDecisionRow | undefined;
    const decision = decisionRow ? parseCanonicalJson(decisionRow.decisionJson) : null;
    if (!decisionRow) {
      reasons.push('decision_missing');
    } else if (!decision
        || decisionRow.decisionId !== binding.decisionId
        || decisionRow.studyId !== binding.studyId
        || decisionRow.unitIdDigest !== binding.unitIdDigest
        || decisionRow.eventHash !== decision.eventHash
        || decision.type !== 'fiscus.causal-decision' || decision.version !== 2
        || decision.decisionId !== binding.decisionId || decision.studyId !== binding.studyId
        || decision.protocolHash !== binding.protocolHash || decision.unitIdDigest !== binding.unitIdDigest
        || decision.eventHash !== decisionRow.eventHash
        || decision.eventHash !== decisionEventHashV2(decision)) {
      reasons.push('decision_identity_mismatch');
    }

    const executionRow = db.prepare(
      `SELECT execution_id AS executionId, decision_id AS decisionId, study_id AS studyId,
              protocol_hash AS protocolHash, started_at_ms AS startedAtMs,
              completed_at_ms AS completedAtMs, event_hash AS eventHash, execution_json AS executionJson
         FROM causal_executions_v2 WHERE execution_id = ?`,
    ).get(binding.executionId) as StoredExecutionRow | undefined;
    let execution: CausalExecutionRecordV2 | null = null;
    if (!executionRow) {
      reasons.push('execution_missing');
    } else {
      try {
        execution = decodeCausalExecutionV2(JSON.parse(String(executionRow.executionJson)));
      } catch {
        reasons.push('execution_identity_mismatch');
      }
      if (!execution
          || executionRow.executionId !== binding.executionId
          || executionRow.decisionId !== binding.decisionId
          || executionRow.studyId !== binding.studyId
          || executionRow.protocolHash !== binding.protocolHash
          || executionRow.startedAtMs !== execution.startedAtMs
          || executionRow.completedAtMs !== execution.completedAtMs
          || executionRow.eventHash !== execution.eventHash
          || execution.executionId !== binding.executionId
          || execution.decisionId !== binding.decisionId
          || execution.studyId !== binding.studyId
          || execution.protocolHash !== binding.protocolHash
          || execution.previousEventHash !== decision?.eventHash
          || !protocol.arms.some((arm) => arm.armId === decision?.assignedArmId
            && arm.providerId !== null && arm.modelId !== null
            && execution?.assignedExecutionPlanDigest === arm.executionPlanDigest
            && execution?.actualExecutionPlanDigest === arm.executionPlanDigest
            && execution?.adherence === 'confirmed')) {
        reasons.push('execution_identity_mismatch');
      }
      if (execution?.ordinaryLedgerVerifier.state === 'unresolved'
          && (execution.directAiCostUsd !== null || execution.fullArmCostUsd !== null)) {
        reasons.push('ledger_verification_unresolved');
      }
      if (execution && execution.directAiCostUsd !== null
          && (!protocol.costOutcome.acceptedSourceClasses.includes(
            execution.directCostSourceClass as 'actual_observed' | 'actual_reconciled',
          )
            || !inBounds(execution.directAiCostUsd, protocol.costOutcome.boundsUsd))) {
        reasons.push('request_cost_evidence_unaccepted');
      }
      if (execution && protocol.question === 'ai_vs_incumbent_net_benefit'
          && (execution.fullArmCostUsd === null
            || !protocol.costOutcome.acceptedSourceClasses.includes(
              execution.fullCostSourceClass as 'actual_observed' | 'actual_reconciled',
            )
            || !inBounds(execution.fullArmCostUsd, protocol.costOutcome.boundsUsd))) {
        reasons.push('request_cost_evidence_unaccepted');
      }
    }

    const outcomeRow = db.prepare(
      `SELECT outcome_id AS outcomeId, decision_id AS decisionId, study_id AS studyId,
              protocol_hash AS protocolHash, observed_at_ms AS observedAtMs, maturity,
              event_hash AS eventHash, terminal_outcome_json AS terminalOutcomeJson
         FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?`,
    ).get(binding.outcomeId) as StoredOutcomeRow | undefined;
    let outcome: CausalTerminalOutcomeRecordV2 | null = null;
    if (!outcomeRow) {
      reasons.push('outcome_missing');
    } else {
      try {
        outcome = decodeCausalTerminalOutcomeV2(JSON.parse(String(outcomeRow.terminalOutcomeJson)));
      } catch {
        reasons.push('outcome_identity_mismatch');
      }
      if (!outcome
          || outcomeRow.outcomeId !== binding.outcomeId
          || outcomeRow.decisionId !== binding.decisionId
          || outcomeRow.studyId !== binding.studyId
          || outcomeRow.protocolHash !== binding.protocolHash
          || outcomeRow.observedAtMs !== outcome.observedAtMs
          || outcomeRow.maturity !== outcome.maturity
          || outcomeRow.eventHash !== outcome.eventHash
          || outcome.outcomeId !== binding.outcomeId
          || outcome.decisionId !== binding.decisionId
          || outcome.studyId !== binding.studyId
          || outcome.protocolHash !== binding.protocolHash
          || (execution !== null && outcome.previousEventHash !== execution.eventHash)) {
        reasons.push('outcome_identity_mismatch');
      }
      if (outcome?.maturity !== 'matured') {
        reasons.push('outcome_not_mature');
      } else if (outcome.observedAtMs < (execution?.completedAtMs ?? Number.MAX_SAFE_INTEGER)
          || !inBounds(outcome.qualityValue, protocol.qualityOutcome.bounds)
          || outcome.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass
          || outcome.outcomeEvidenceDigests.length === 0
          || outcome.outcomeEvidenceDigests.some((digest) => !isDigest(digest))) {
        reasons.push('outcome_not_mature');
      } else if (protocol.question === 'ai_vs_incumbent_net_benefit') {
        const economic = protocol.economicOutcome;
        if (!economic
            || !inBounds(outcome.economicValueUsd, economic.boundsUsd)
            || outcome.economicEvidenceClass !== economic.evidenceClass) {
          reasons.push('outcome_not_mature');
        }
      } else if (outcome.economicValueUsd !== null || outcome.economicEvidenceClass !== null) {
        reasons.push('outcome_not_mature');
      }
    }

    if (!execution) {
      // No request query can be authoritative without the exact execution
      // window and request-id list.
      return invalidResult(reasons, binding.bindingDigest);
    }
    if (!equalRequestIds(binding.requestIds, execution.requestIds)) reasons.push('request_ids_mismatch');
    const placeholders = binding.requestIds.map(() => '?').join(', ');
    const requestRows = db.prepare(
      `SELECT request_id AS requestId, ts_epoch_ms AS tsEpochMs, provider, model, project,
              cost_usd AS costUsd, estimated, via,
              cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256,
              rate_card_source_kind AS rateCardSourceKind, rate_match_kind AS rateMatchKind,
              rate_match_provider AS rateMatchProvider, rate_match_model AS rateMatchModel,
              scope_capture_status AS scopeCaptureStatus,
              provider_scope_declaration_id AS providerScopeDeclarationId
         FROM requests WHERE request_id IN (${placeholders})
         ORDER BY request_id`,
    ).all(...binding.requestIds) as unknown as StoredRequestRow[];
    requestCount = requestRows.length;
    if (requestRows.length !== binding.requestIds.length) reasons.push('request_missing');

    const arm = protocol.arms.find((candidate) => candidate.armId === decision?.assignedArmId);
    const declarationIds = new Set<string>();
    let totalMicros = 0n;
    const expectedPriceDigests: string[] = [];
    for (const row of requestRows) {
      const ts = asSafeInteger(row.tsEpochMs);
      const costUsd = asNumber(row.costUsd);
      const rowRequestId = typeof row.requestId === 'string' ? row.requestId : null;
      const provider = typeof row.provider === 'string' ? row.provider : null;
      const model = typeof row.model === 'string' ? row.model : null;
      const project = typeof row.project === 'string' ? row.project : null;
      const declarationId = typeof row.providerScopeDeclarationId === 'string' ? row.providerScopeDeclarationId : null;
      if (!rowRequestId || ts === null || costUsd === null || provider === null || model === null || project === null) {
        reasons.push('request_cost_evidence_unaccepted');
        continue;
      }
      if (ts < execution.startedAtMs || ts > execution.completedAtMs) reasons.push('request_cost_evidence_unaccepted');
      if (arm?.providerId !== provider) reasons.push('request_provider_mismatch');
      if (arm?.modelId !== model) reasons.push('request_model_mismatch');
      if (row.via !== 'proxy' || row.estimated !== 0
          || row.costBasis !== 'tool_reported_unverified'
          || row.rateCardSha256 !== null || row.rateCardSourceKind !== 'none'
          || row.rateMatchKind !== 'reported' || row.rateMatchProvider !== null || row.rateMatchModel !== null
          || costUsd < 0 || micros(costUsd) === null) {
        reasons.push('request_cost_evidence_unaccepted');
      }
      if (declarationId === null || row.scopeCaptureStatus !== 'declared_unverified') {
        reasons.push('request_scope_unresolved');
      } else {
        declarationIds.add(declarationId);
        const declaration = db.prepare(
          `SELECT declaration_id AS declarationId, provider,
                  provider_project_ref AS providerProjectRef, trust
             FROM provider_scope_declarations WHERE declaration_id = ?`,
        ).get(declarationId) as StoredScopeDeclarationRow | undefined;
        if (!declaration || declaration.declarationId !== declarationId
            || declaredProviderKey(provider) !== declaration.provider
            || declaration.providerProjectRef !== project
            || declaration.trust !== 'operator_declared_unverified') {
          reasons.push('request_scope_unresolved');
        }
      }
      const costMicros = micros(costUsd);
      if (costMicros === null) {
        reasons.push('request_cost_evidence_unaccepted');
      } else {
        totalMicros += BigInt(costMicros);
        expectedPriceDigests.push(causalRequestPricingDigestV2({
          requestId: rowRequestId,
          tsEpochMs: ts,
          provider,
          model,
          project,
          costMicros,
          costBasis: 'tool_reported_unverified',
          rateCardSha256: null,
          rateCardSourceKind: 'none',
          rateMatchKind: 'reported',
          rateMatchProvider: null,
          rateMatchModel: null,
          scopeCaptureStatus: 'declared_unverified',
          providerScopeDeclarationId: declarationId ?? '',
        }));
      }
    }
    if (declarationIds.size !== 1) reasons.push('request_scope_unresolved');
    const totalCost = totalMicros <= MAX_SAFE_MICROS ? Number(totalMicros) / 1_000_000 : null;
    actualCostUsd = requestRows.length === binding.requestIds.length ? totalCost : null;
    const directMicros = execution.directAiCostUsd === null ? null : micros(execution.directAiCostUsd);
    if (directMicros === null || BigInt(directMicros) !== totalMicros) {
      reasons.push('request_cost_scalar_mismatch');
      actualCostUsd = null;
    }
    expectedPriceDigests.sort();
    const actualPriceDigests = [...execution.priceLineageDigests].sort();
    if (canonicalJson(actualPriceDigests) !== canonicalJson(expectedPriceDigests)) reasons.push('request_price_lineage_mismatch');

    const realizationRow = db.prepare(
      `SELECT commit_hash AS commitHash, project, ts_epoch_ms AS tsEpochMs,
              computed_at_ms AS computedAtMs, attributed_cost_usd AS attributedCostUsd,
              maturing, realized, cost_scope AS costScope, cost_stale AS costStale
         FROM realization_units WHERE commit_hash = ?`,
    ).get(binding.realizationCommitHash) as StoredRealizationRow | undefined;
    if (!realizationRow) {
      reasons.push('realization_missing');
    } else {
      const project = typeof realizationRow.project === 'string' ? realizationRow.project : null;
      const ts = asPositiveSafeInteger(realizationRow.tsEpochMs);
      const computedAtMs = asPositiveSafeInteger(realizationRow.computedAtMs);
      const attributedCostUsd = asNumber(realizationRow.attributedCostUsd);
      const maturityFlagValid = realizationRow.maturing === 0 || realizationRow.maturing === 1;
      const realizedFlagValid = realizationRow.realized === 0 || realizationRow.realized === 1;
      const staleFlagValid = realizationRow.costStale === 0 || realizationRow.costStale === 1;
      const maturing = realizationRow.maturing === 1;
      const realized = realizationRow.realized === 1;
      const costScope = realizationRow.costScope;
      const costStale = realizationRow.costStale === 1;
      if (project === null || ts === null || computedAtMs === null || attributedCostUsd === null
          || attributedCostUsd < 0
          || !maturityFlagValid || !realizedFlagValid || !staleFlagValid
          || !['project', 'window'].includes(String(costScope))
          || computedAtMs < ts) {
        reasons.push('realization_scope_invalid');
      }
      if (maturing || !realized || costStale) reasons.push('realization_not_mature');
      if (requestRows.some((row) => row.project !== project)) reasons.push('realization_project_mismatch');
      if (project !== null && ts !== null && computedAtMs !== null && attributedCostUsd !== null
          && (costScope === 'project' || costScope === 'window')) {
        realizedDigest = causalRealizationSnapshotDigestV2({
          commitHash: binding.realizationCommitHash,
          project,
          tsEpochMs: ts,
          computedAtMs,
          attributedCostUsd,
          maturing,
          realized,
          costScope,
          costStale,
        });
        if (realizedDigest !== binding.realizationSnapshotDigest) reasons.push('realization_snapshot_digest_mismatch');
      }
    }
  } catch {
    return invalidResult(
      [...reasons, 'causal_schema_unavailable'],
      binding.bindingDigest,
      requestCount,
      actualCostUsd,
      realizedDigest,
    );
  }
  const costResultInvalid = reasons.some((reason) =>
    reason === 'ledger_verification_unresolved' || reason.startsWith('request_'),
  );
  if (costResultInvalid) actualCostUsd = null;
  return reasons.length === 0
    ? {
      state: 'valid',
      reasonCodes: [],
      bindingDigest: binding.bindingDigest,
      requestCount,
      actualCostUsd,
      realizationSnapshotDigest: realizedDigest,
    }
    : invalidResult(reasons, binding.bindingDigest, requestCount, actualCostUsd, realizedDigest);
}

/**
 * The sidecar stores one canonical JSON envelope as a replay anchor, while
 * duplicating every identity-bearing scalar in physical columns.  Reloads
 * authenticate both representations before returning anything to Store code.
 */
interface StoredCausalLineageBindingV2Row {
  binding_id: unknown;
  study_id: unknown;
  protocol_hash: unknown;
  decision_id: unknown;
  execution_id: unknown;
  outcome_id: unknown;
  unit_id_digest: unknown;
  request_ids_json: unknown;
  realization_commit_hash: unknown;
  realization_snapshot_digest: unknown;
  binding_digest: unknown;
  binding_json: unknown;
}

const STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT =
  'SELECT binding_id, study_id, protocol_hash, decision_id, execution_id, outcome_id, ' +
  'unit_id_digest, request_ids_json, realization_commit_hash, realization_snapshot_digest, ' +
  'binding_digest, binding_json ';

class CausalLineageStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'CausalLineageStoreError';
    this.code = code;
  }
}

function lineageFail(code: string, message: string): never {
  throw new CausalLineageStoreError(code, message);
}

function parseCanonicalRequestIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)
        || value.length === 0
        || value.some((id): id is string => !isCausalIdentifier(id))
        || new Set(value).size !== value.length
        || value.some((id, index) => index > 0 && value[index - 1]! > id)
        || canonicalJson(value) !== raw) {
      return null;
    }
    return [...value] as string[];
  } catch {
    return null;
  }
}

function storedText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('lineage physical text storage');
  return value;
}

function authenticateStoredCausalLineageBindingV2(
  row: StoredCausalLineageBindingV2Row,
): CausalLineageBindingV2 {
  try {
    const encoded = storedText(row.binding_json);
    const parsed = JSON.parse(encoded) as unknown;
    const binding = immutableBinding(parsed);
    if (!binding || canonicalJson(binding) !== encoded) throw new Error('lineage JSON is not canonical');
    const requestIds = parseCanonicalRequestIds(row.request_ids_json);
    if (!requestIds || !equalRequestIds(requestIds, binding.requestIds)
        || storedText(row.binding_id) !== binding.bindingId
        || storedText(row.study_id) !== binding.studyId
        || storedText(row.protocol_hash) !== binding.protocolHash
        || storedText(row.decision_id) !== binding.decisionId
        || storedText(row.execution_id) !== binding.executionId
        || storedText(row.outcome_id) !== binding.outcomeId
        || storedText(row.unit_id_digest) !== binding.unitIdDigest
        || storedText(row.realization_commit_hash) !== binding.realizationCommitHash
        || storedText(row.realization_snapshot_digest) !== binding.realizationSnapshotDigest
        || storedText(row.binding_digest) !== binding.bindingDigest) {
      throw new Error('lineage physical identity');
    }
    return binding;
  } catch {
    lineageFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 lineage binding failed integrity verification');
  }
}

function onlyUnresolvedLedgerBlock(validation: CausalLineageBindingValidationV2): boolean {
  return validation.state === 'invalid'
    && validation.reasonCodes.length === 1
    && validation.reasonCodes[0] === 'ledger_verification_unresolved';
}

function normalizedLineageError(error: unknown): Error {
  if (error instanceof CausalLineageStoreError) return error;
  if (error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (code === 'CAUSAL_RECORD_INVALID') {
      return new CausalLineageStoreError('CAUSAL_RECORD_INVALID', 'causal lineage binding is invalid');
    }
    if (code === 'CAUSAL_INTEGRITY_FAILURE') {
      return new CausalLineageStoreError('CAUSAL_INTEGRITY_FAILURE', 'stored v2 lineage binding failed integrity verification');
    }
    if (code === 'CAUSAL_BUSY') {
      return new CausalLineageStoreError('CAUSAL_BUSY', 'lineage writer is busy; retry this immutable request');
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new CausalLineageStoreError('CAUSAL_BUSY', 'lineage writer is busy; retry this immutable request');
  }
  if (/UNIQUE constraint failed.*causal_lineage_bindings_v2/i.test(message)) {
    return new CausalLineageStoreError(
      'CAUSAL_IMMUTABLE_CONFLICT',
      'lineage binding conflicts with an existing immutable record',
    );
  }
  return new CausalLineageStoreError(
    'CAUSAL_APPEND_ROLLED_BACK',
    'lineage binding transaction rolled back without disclosing a causal record',
  );
}

/**
 * Append one authenticated scalar binding.  The only currently admissible
 * non-valid result is the explicit ordinary-ledger-verifier blocker: that
 * permits the sidecar to record the causal join without allowing it to turn an
 * unresolved cost ledger into a qualified result.
 */
export function appendCausalLineageBindingV2(
  db: DatabaseSync,
  value: unknown,
): 'created' | 'existing' {
  const binding = immutableBinding(value);
  if (!binding) lineageFail('CAUSAL_RECORD_INVALID', 'causal lineage binding shape is invalid');
  const material: BindingMaterial = {
    type: binding.type,
    version: binding.version,
    bindingId: binding.bindingId,
    studyId: binding.studyId,
    protocolHash: binding.protocolHash,
    decisionId: binding.decisionId,
    executionId: binding.executionId,
    outcomeId: binding.outcomeId,
    unitIdDigest: binding.unitIdDigest,
    requestIds: [...binding.requestIds],
    realizationCommitHash: binding.realizationCommitHash,
    realizationSnapshotDigest: binding.realizationSnapshotDigest,
  };
  if (causalLineageBindingDigestV2(material) !== binding.bindingDigest) {
    lineageFail('CAUSAL_RECORD_INVALID', 'causal lineage binding digest is invalid');
  }
  const encoded = canonicalJson(binding);
  const requestIdsJson = canonicalJson(binding.requestIds);
  let committed = false;
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    if (!causalV2SchemaComplete(db)) {
      lineageFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 lineage schema is not exact');
    }
    const validation = validateCausalLineageBindingV2(db, binding);
    if (validation.state === 'invalid') {
      if (validation.reasonCodes.includes('causal_schema_unavailable')) {
        lineageFail('CAUSAL_INTEGRITY_FAILURE', 'causal lineage records could not be authenticated');
      }
      if (!onlyUnresolvedLedgerBlock(validation)) {
        lineageFail('CAUSAL_RECORD_INVALID', 'causal lineage binding failed validation');
      }
    }

    const byIdRows = db.prepare(
      STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT +
      'FROM causal_lineage_bindings_v2 WHERE binding_id = ?',
    ).all(binding.bindingId) as unknown as StoredCausalLineageBindingV2Row[];
    if (byIdRows.length > 1) {
      lineageFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 lineage binding identity is duplicated');
    }
    const byId = byIdRows[0];
    if (byId) {
      const existing = authenticateStoredCausalLineageBindingV2(byId);
      if (canonicalJson(existing) === encoded) {
        db.prepare('COMMIT').run();
        committed = true;
        return 'existing';
      }
      lineageFail('CAUSAL_IMMUTABLE_CONFLICT', 'lineage binding conflicts with existing immutable content');
    }

    // All identity collisions are classified only after authenticating the
    // colliding rows. A corrupt row is never silently treated as a duplicate.
    const competing = db.prepare(
      STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT +
      'FROM causal_lineage_bindings_v2 WHERE decision_id = ? OR execution_id = ? ' +
      'OR outcome_id = ? OR binding_digest = ?',
    ).all(binding.decisionId, binding.executionId, binding.outcomeId, binding.bindingDigest) as unknown as StoredCausalLineageBindingV2Row[];
    for (const row of competing) authenticateStoredCausalLineageBindingV2(row);
    if (competing.length > 0) {
      lineageFail('CAUSAL_IMMUTABLE_CONFLICT', 'lineage binding conflicts with an existing immutable identity');
    }

    const retained = db.prepare(
      STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT +
      'FROM causal_lineage_bindings_v2 ORDER BY binding_id',
    ).all() as unknown as StoredCausalLineageBindingV2Row[];
    const requestSet = new Set(binding.requestIds);
    for (const row of retained) {
      const existing = authenticateStoredCausalLineageBindingV2(row);
      if (existing.requestIds.some((requestId) => requestSet.has(requestId))) {
        lineageFail('CAUSAL_IMMUTABLE_CONFLICT', 'lineage binding reuses an existing request identity');
      }
    }

    db.prepare(
      'INSERT INTO causal_lineage_bindings_v2 ' +
      '(binding_id, study_id, protocol_hash, decision_id, execution_id, outcome_id, ' +
      'unit_id_digest, request_ids_json, realization_commit_hash, realization_snapshot_digest, ' +
      'binding_digest, binding_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      binding.bindingId,
      binding.studyId,
      binding.protocolHash,
      binding.decisionId,
      binding.executionId,
      binding.outcomeId,
      binding.unitIdDigest,
      requestIdsJson,
      binding.realizationCommitHash,
      binding.realizationSnapshotDigest,
      binding.bindingDigest,
      encoded,
    );

    const reloadedRows = db.prepare(
      STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT +
      'FROM causal_lineage_bindings_v2 WHERE binding_id = ?',
    ).all(binding.bindingId) as unknown as StoredCausalLineageBindingV2Row[];
    if (reloadedRows.length !== 1) {
      lineageFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 lineage binding did not reload exactly once');
    }
    const reloaded = reloadedRows[0];
    if (!reloaded) lineageFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 lineage binding could not be reloaded');
    const authenticated = authenticateStoredCausalLineageBindingV2(reloaded);
    if (canonicalJson(authenticated) !== encoded) {
      lineageFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 lineage binding did not replay canonically');
    }
    db.prepare('COMMIT').run();
    committed = true;
    return 'created';
  } catch (error) {
    if (!committed) {
      try { db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
    }
    throw normalizedLineageError(error);
  }
}

export interface CausalLineageBindingLookupV2 {
  decisionIds?: readonly string[];
  executionIds?: readonly string[];
  outcomeIds?: readonly string[];
}

/**
 * Read authenticated sidecar rows for a study. Optional identity sets let the
 * qualification reader include cross-study/orphan rows that could otherwise
 * be mistaken for harmless absence.
 */
export function causalLineageBindingsV2(
  db: DatabaseSync,
  studyId: string,
  lookup: CausalLineageBindingLookupV2 = {},
): CausalLineageBindingV2[] {
  if (!isCausalIdentifier(studyId)) lineageFail('CAUSAL_RECORD_INVALID', 'causal study id is invalid');
  const identityLists = [lookup.decisionIds ?? [], lookup.executionIds ?? [], lookup.outcomeIds ?? []];
  if (identityLists.some((ids) => ids.some((id) => !isCausalIdentifier(id)))) {
    lineageFail('CAUSAL_RECORD_INVALID', 'causal lineage identity is invalid');
  }
  if (!causalV2SchemaComplete(db)) {
    lineageFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 lineage schema is not exact');
  }
  const clauses = ['study_id = ?'];
  const args: string[] = [studyId];
  for (const [column, values] of [
    ['decision_id', lookup.decisionIds ?? []],
    ['execution_id', lookup.executionIds ?? []],
    ['outcome_id', lookup.outcomeIds ?? []],
  ] as const) {
    if (values.length > 0) {
      clauses.push(column + ' IN (' + values.map(() => '?').join(', ') + ')');
      args.push(...values);
    }
  }
  const rows = db.prepare(
    STORED_CAUSAL_LINEAGE_BINDING_V2_SELECT +
    'FROM causal_lineage_bindings_v2 WHERE ' + clauses.join(' OR ') +
    ' ORDER BY study_id, decision_id, binding_id',
  ).all(...args) as unknown as StoredCausalLineageBindingV2Row[];
  return rows.map((row) => authenticateStoredCausalLineageBindingV2(row));
}

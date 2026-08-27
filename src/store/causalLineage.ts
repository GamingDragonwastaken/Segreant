/**
 * Store-internal T-069 lineage resolver.
 *
 * This module is deliberately read-only.  It validates a proposed, minimal
 * binding against the already-retained V2 causal records, request ledger, and
 * scalar realization snapshot.  It does not create a sidecar row yet: adding
 * one safely requires a new schema contract, append-only triggers, and a named
 * predecessor migration.  Until that slice exists, qualification must remain
 * fail-closed for cost-bearing V2 evidence.
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
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return false;
    }
    const requestIds = value.requestIds;
    if (!Array.isArray(requestIds)
        || requestIds.length === 0
        || !requestIds.every((id): id is string => isCausalIdentifier(id))
        || new Set(requestIds).size !== requestIds.length
        || requestIds.some((id, index) => index > 0 && requestIds[index - 1]! > id)) {
      return false;
    }
    const realizationCommitHash = value.realizationCommitHash;
    if (value.type !== 'fiscus.causal-lineage-binding' || value.version !== 2
        || !isCausalIdentifier(value.bindingId) || !isCausalIdentifier(value.studyId)
        || !isDigest(value.protocolHash) || !isCausalIdentifier(value.decisionId)
        || !isCausalIdentifier(value.executionId) || !isCausalIdentifier(value.outcomeId)
        || !isDigest(value.unitIdDigest)
        || typeof realizationCommitHash !== 'string' || !GIT_COMMIT_RE.test(realizationCommitHash)
        || !isDigest(value.realizationSnapshotDigest) || !isDigest(value.bindingDigest)) {
      return false;
    }
    return true;
  } catch {
    return false;
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
  if (!validBindingShape(value)) return invalidResult(['binding_shape_invalid'], candidateDigest);
  const binding = value;
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
          && execution.ordinaryLedgerVerifier.reasonCodes.includes('task4_not_implemented')
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

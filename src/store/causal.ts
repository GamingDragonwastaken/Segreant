/**
 * SQLite persistence for local causal-study evidence.
 *
 * Rows are append-only after insertion. The store does not accept raw prompts
 * or source text as first-class evidence; the canonical types use identifiers,
 * hashes, and declared numerical outcomes only.
 */

import { createHash, randomFillSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { estimateCausalStudy } from '../causal/estimate.ts';
import { CAUSAL_PROTOCOL_VERSION } from '../causal/types.ts';
import {
  decodeCausalExecutionV2,
  decodeCausalTerminalOutcomeV2,
} from '../causal/records.ts';
import {
  canonicalJson,
  sha256,
  isCausalIdentifier,
  verifyCausalEvent,
  verifyCommittedCausalProtocol,
} from '../causal/protocol.ts';
import type {
  CausalAssignmentBlockV2,
  CausalAssignmentPlan,
  CausalAssignmentPlanV2,
  CausalAssignmentManifestV2,
  CausalAssignmentRequestV2,
  CausalAssignmentResultV2,
  CausalDecisionRecordV2,
  CausalExecutionRecordV2,
  CausalTerminalOutcomeRecordV2,
  CausalExecutionRecord,
  CausalOutcomeRecord,
  CausalQualificationV2,
  CausalStudyDataV2,
  CausalStudyData,
  CausalStudyEstimate,
  CommittedCausalStudyProtocol,
  CommittedCausalStudyProtocolV2,
  AnyCommittedCausalStudyProtocol,
} from '../causal/types.ts';
import {
  CAUSAL_LINEAGE_BINDING_NOT_PERSISTED,
  CAUSAL_LINEAGE_BINDING_INVALID,
  causalLineageBindingsV2,
  validateCausalLineageBindingV2,
  type CausalLineageBindingValidationV2,
  type CausalLineageBindingV2,
} from './causalLineage.ts';
import { causalV2SchemaComplete } from './schema.ts';

export interface CausalAnalysisSnapshot {
  analysisId: string;
  computedAtMs: number;
  estimate: CausalStudyEstimate;
}

export interface CausalStudySummary {
  studyId: string;
  protocolHash: string;
  committedAtMs: number;
  decisions: number;
  executions: number;
  outcomes: number;
  latestAnalysis: { analysisId: string; computedAtMs: number; state: string } | null;
}

class CausalLegacyInspectOnlyError extends Error {
  readonly code = 'CAUSAL_LEGACY_INSPECT_ONLY';

  constructor(operation: string) {
    super('CAUSAL_LEGACY_INSPECT_ONLY: retained version-1 causal evidence is inspect-only; cannot ' + operation);
    this.name = 'CausalLegacyInspectOnlyError';
  }
}

function rejectLegacyMutation(protocol: AnyCommittedCausalStudyProtocol, operation: string): void {
  if (protocol.version === 1) throw new CausalLegacyInspectOnlyError(operation);
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('stored causal ' + label + ' is malformed');
  }
}

interface StoredProtocolRow {
  study_id: unknown;
  protocol_hash: unknown;
  committed_at_ms_type: unknown;
  committed_at_ms_text: unknown;
  protocol_json: unknown;
}

type DecodedStoredProtocol =
  | { version: 1; protocol: CommittedCausalStudyProtocol }
  | { version: 2; protocol: CommittedCausalStudyProtocolV2 };

class CausalProtocolIntegrityError extends Error {
  readonly code = 'CAUSAL_INTEGRITY_FAILURE';

  constructor() {
    super('CAUSAL_INTEGRITY_FAILURE: stored causal protocol failed integrity verification');
    this.name = 'CausalProtocolIntegrityError';
  }
}

class CausalProtocolValidationError extends Error {
  readonly code = 'CAUSAL_PROTOCOL_INVALID';

  constructor() {
    super('CAUSAL_PROTOCOL_INVALID: supplied causal protocol is invalid');
    this.name = 'CausalProtocolValidationError';
  }
}

class CausalProtocolConflictError extends Error {
  readonly code = 'CAUSAL_IMMUTABLE_CONFLICT';

  constructor() {
    super('CAUSAL_IMMUTABLE_CONFLICT: studyId is already committed with different immutable protocol content');
    this.name = 'CausalProtocolConflictError';
  }
}

const V1_COMMITTED_PROTOCOL_KEYS = [
  'type', 'version', 'studyId', 'createdAtMs', 'question', 'eligibility',
  'arms', 'allocation', 'costOutcome', 'qualityOutcome', 'economicOutcome',
  'analysis', 'lifecycle', 'committedAtMs', 'protocolHash',
] as const;

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * The retained v1 verifier deliberately hashes a projected compatibility
 * material. Store reads additionally require the exact historical schema so
 * canonical-but-extended records cannot acquire public meaning by projection.
 */
function hasExactCommittedProtocolV1Shape(value: unknown): value is CommittedCausalStudyProtocol {
  if (!hasExactKeys(value, V1_COMMITTED_PROTOCOL_KEYS)) return false;
  if (!hasExactKeys(value.eligibility, ['cohortId', 'unitOfAssignment', 'contextSchemaId'])) return false;
  if (!Array.isArray(value.arms)
      || !value.arms.every((arm) => hasExactKeys(arm, ['armId', 'role', 'executionPlanHash', 'providerId', 'modelId']))) {
    return false;
  }
  if (!hasExactKeys(value.allocation, ['method', 'probabilityPerArm', 'blockSize'])) return false;
  if (!hasExactKeys(value.costOutcome, ['metricId', 'boundsUsd', 'acceptedSourceClasses'])
      || !hasExactKeys(value.costOutcome.boundsUsd, ['low', 'high'])) {
    return false;
  }
  if (!hasExactKeys(value.qualityOutcome, ['metricId', 'bounds', 'evidenceClass', 'nonInferiorityMargin'])
      || !hasExactKeys(value.qualityOutcome.bounds, ['low', 'high'])) {
    return false;
  }
  if (value.economicOutcome !== null
      && (!hasExactKeys(value.economicOutcome, ['metricId', 'boundsUsd', 'evidenceClass', 'fullCostAccountingRequired'])
        || !hasExactKeys(value.economicOutcome.boundsUsd, ['low', 'high']))) {
    return false;
  }
  return hasExactKeys(
    value.analysis,
    ['estimand', 'confidenceLevel', 'minCompletedPerArm', 'maxMissingFractionPerArm'],
  );
}

const SQLITE_INT64_MIN = -9223372036854775808n;
const SQLITE_INT64_MAX = 9223372036854775807n;
const CANONICAL_SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;

/**
 * Decode SQLite's integer column without asking node:sqlite to materialize an
 * untrusted 64-bit value as a JavaScript Number. Number materialization can
 * throw for values outside the driver's safe range, which would bypass the
 * redacted integrity boundary. The storage class and canonical decimal text
 * are therefore the only physical timestamp inputs accepted here.
 */
function decodeStoredIntegerMs(storageClass: unknown, decimalText: unknown): number {
  if (storageClass !== 'integer'
      || typeof decimalText !== 'string'
      || !CANONICAL_SIGNED_DECIMAL.test(decimalText)) {
    throw new Error('invalid committed timestamp storage');
  }
  let integer: bigint;
  try {
    integer = BigInt(decimalText);
  } catch {
    throw new Error('invalid committed timestamp integer');
  }
  if (integer < SQLITE_INT64_MIN || integer > SQLITE_INT64_MAX) {
    throw new Error('committed timestamp is outside SQLite signed64 range');
  }
  const value = Number(integer);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('committed timestamp is outside JavaScript safe range');
  }
  return value;
}

function decodeStoredCommittedAtMs(row: StoredProtocolRow): number {
  return decodeStoredIntegerMs(row.committed_at_ms_type, row.committed_at_ms_text);
}

function decodeStoredAnalysisAtMs(row: {
  analysis_id: unknown;
  analysis_at_type: unknown;
  analysis_at_text: unknown;
}): number | null {
  if (row.analysis_id === null || row.analysis_id === undefined) return null;
  try {
    return decodeStoredIntegerMs(row.analysis_at_type, row.analysis_at_text);
  } catch {
    throw new CausalProtocolIntegrityError();
  }
}

function decodeSuppliedProtocol(protocolValue: unknown): AnyCommittedCausalStudyProtocol {
  const validationErrors = verifyCommittedCausalProtocol(protocolValue);
  if (validationErrors.length > 0) throw new CausalProtocolValidationError();
  if (isRecord(protocolValue)
      && protocolValue.version === CAUSAL_PROTOCOL_VERSION
      && !hasExactCommittedProtocolV1Shape(protocolValue)) {
    throw new CausalProtocolValidationError();
  }
  return protocolValue as AnyCommittedCausalStudyProtocol;
}

const STORED_PROTOCOL_SELECT =
  'SELECT study_id, protocol_hash, typeof(committed_at_ms) AS committed_at_ms_type, ' +
  'CAST(committed_at_ms AS TEXT) AS committed_at_ms_text, protocol_json ';

/**
 * Authenticate the physical row, exact JSON schema, semantic commitment, and
 * canonical bytes as one boundary. Only an exact valid v2 row may be hidden by
 * retained-v1 readers; every other defect is a typed, redacted integrity error.
 */
function decodeStoredProtocolRow(row: StoredProtocolRow): DecodedStoredProtocol {
  try {
    if (typeof row.protocol_json !== 'string') throw new Error('invalid protocol JSON storage class');
    const decoded: unknown = JSON.parse(row.protocol_json);
    if (!isRecord(decoded)) throw new Error('invalid protocol root');

    let result: DecodedStoredProtocol;
    if (decoded.version === 1) {
      if (!hasExactCommittedProtocolV1Shape(decoded)) throw new Error('invalid v1 protocol schema');
      if (verifyCommittedCausalProtocol(decoded).length > 0) throw new Error('invalid v1 protocol commitment');
      result = { version: 1, protocol: decoded };
    } else if (decoded.version === 2) {
      if (verifyCommittedCausalProtocol(decoded).length > 0) throw new Error('invalid v2 protocol commitment');
      result = { version: 2, protocol: decoded as unknown as CommittedCausalStudyProtocolV2 };
    } else {
      throw new Error('unsupported protocol version');
    }

    const protocol = result.protocol;
    const committedAtMs = decodeStoredCommittedAtMs(row);
    if (row.study_id !== protocol.studyId
        || row.protocol_hash !== protocol.protocolHash
        || committedAtMs !== protocol.committedAtMs
        || row.protocol_json !== canonicalJson(protocol)) {
      throw new Error('protocol physical identity or canonical bytes disagree');
    }
    return result;
  } catch {
    throw new CausalProtocolIntegrityError();
  }
}

function loadProtocol(db: DatabaseSync, studyId: string): AnyCommittedCausalStudyProtocol | null {
  const row = db.prepare(
    STORED_PROTOCOL_SELECT + 'FROM causal_protocols WHERE study_id = ?',
  ).get(studyId) as StoredProtocolRow | undefined;
  return row ? decodeStoredProtocolRow(row).protocol : null;
}

function requireStoredProtocol(
  db: DatabaseSync,
  studyId: string,
  protocolHash: string,
): AnyCommittedCausalStudyProtocol {
  const protocol = loadProtocol(db, studyId);
  if (!protocol || protocol.protocolHash !== protocolHash) {
    throw new Error('causal event does not bind a registered protocol');
  }
  const errors = verifyCommittedCausalProtocol(protocol);
  if (errors.length > 0) throw new Error('stored causal protocol is invalid: ' + errors.join('; '));
  return protocol;
}

export function registerCausalProtocol(
  db: DatabaseSync,
  protocolValue: unknown,
): 'created' | 'existing' {
  const protocol = decodeSuppliedProtocol(protocolValue);
  rejectLegacyMutation(protocol, 'register a version-1 protocol');
  const encoded = canonicalJson(protocol);
  const existing = db.prepare(
    STORED_PROTOCOL_SELECT + 'FROM causal_protocols WHERE study_id = ?',
  ).get(protocol.studyId) as StoredProtocolRow | undefined;
  if (existing) {
    const decoded = decodeStoredProtocolRow(existing);
    if (decoded.protocol.protocolHash === protocol.protocolHash
        && decoded.protocol.version === protocol.version
        && canonicalJson(decoded.protocol) === encoded) return 'existing';
    throw new CausalProtocolConflictError();
  }
  db.prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, encoded);
  return 'created';
}

export function saveCausalAssignmentPlan(
  _db: DatabaseSync,
  _plan: CausalAssignmentPlan,
): 'created' | 'existing' {
  throw new CausalLegacyInspectOnlyError('save a version-1 assignment plan');
}

function loadDecision(db: DatabaseSync, decisionId: string): { eventHash: string; studyId: string; protocolHash: string } | null {
  const row = db.prepare(
    'SELECT event_hash, study_id, protocol_hash FROM causal_decisions WHERE decision_id = ?',
  ).get(decisionId) as { event_hash: string; study_id: string; protocol_hash: string } | undefined;
  return row ? { eventHash: row.event_hash, studyId: row.study_id, protocolHash: row.protocol_hash } : null;
}

function loadExecution(db: DatabaseSync, executionId: string): { eventHash: string; studyId: string; protocolHash: string } | null {
  const row = db.prepare(
    'SELECT event_hash, study_id, protocol_hash FROM causal_executions WHERE execution_id = ?',
  ).get(executionId) as { event_hash: string; study_id: string; protocol_hash: string } | undefined;
  return row ? { eventHash: row.event_hash, studyId: row.study_id, protocolHash: row.protocol_hash } : null;
}

/**
 * Append an execution only when it follows a stored decision. Full outcome and
 * measurement qualification remains a separate, reproducible analysis gate.
 */
export function appendCausalExecution(db: DatabaseSync, record: CausalExecutionRecord): 'created' | 'existing' {
  const protocol = requireStoredProtocol(db, record.studyId, record.protocolHash);
  rejectLegacyMutation(protocol, 'append a version-1 execution');
  const decision = loadDecision(db, record.decisionId);
  if (!decision || decision.studyId !== record.studyId || decision.protocolHash !== record.protocolHash ||
      decision.eventHash !== record.previousEventHash || !verifyCausalEvent(record as unknown as Record<string, unknown>)) {
    throw new Error('causal execution does not follow its stored decision exactly');
  }
  const encoded = canonicalJson(record);
  const existing = db.prepare('SELECT execution_json FROM causal_executions WHERE execution_id = ?')
    .get(record.executionId) as { execution_json: string } | undefined;
  if (existing) {
    if (existing.execution_json === encoded) return 'existing';
    throw new Error('executionId is already recorded with different immutable content');
  }
  db.prepare(
    'INSERT INTO causal_executions (execution_id, decision_id, study_id, protocol_hash, completed_at_ms, event_hash, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(record.executionId, record.decisionId, record.studyId, record.protocolHash, record.completedAtMs, record.eventHash, encoded);
  return 'created';
}

class CausalExecutionStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'CausalExecutionStoreError';
    this.code = code;
  }
}

function executionFail(code: string, message: string): never {
  throw new CausalExecutionStoreError(code, message);
}

interface StoredExecutionV2Row {
  execution_id: unknown;
  decision_id: unknown;
  study_id: unknown;
  protocol_hash: unknown;
  started_at_ms_type: unknown;
  started_at_ms_text: unknown;
  completed_at_ms_type: unknown;
  completed_at_ms_text: unknown;
  previous_event_hash: unknown;
  event_hash: unknown;
  execution_json: unknown;
}

const STORED_EXECUTION_V2_SELECT =
  'SELECT execution_id, decision_id, study_id, protocol_hash, ' +
  'typeof(started_at_ms) AS started_at_ms_type, CAST(started_at_ms AS TEXT) AS started_at_ms_text, ' +
  'typeof(completed_at_ms) AS completed_at_ms_type, CAST(completed_at_ms AS TEXT) AS completed_at_ms_text, ' +
  'previous_event_hash, event_hash, execution_json ';

function authenticateStoredExecutionV2(row: StoredExecutionV2Row): CausalExecutionRecordV2 {
  try {
    if (typeof row.execution_json !== 'string') throw new Error('execution json storage class');
    const record = decodeCausalExecutionV2(JSON.parse(row.execution_json));
    if (row.execution_json !== canonicalJson(record)) throw new Error('execution json is not canonical');
    const startedAtMs = decodeStoredIntegerMs(row.started_at_ms_type, row.started_at_ms_text);
    const completedAtMs = decodeStoredIntegerMs(row.completed_at_ms_type, row.completed_at_ms_text);
    if (row.execution_id !== record.executionId || row.decision_id !== record.decisionId
        || row.study_id !== record.studyId || row.protocol_hash !== record.protocolHash
        || startedAtMs !== record.startedAtMs || completedAtMs !== record.completedAtMs
        || row.previous_event_hash !== record.previousEventHash || row.event_hash !== record.eventHash) {
      throw new Error('execution physical identity');
    }
    return record;
  } catch (error) {
    if (error instanceof CausalExecutionStoreError) throw error;
    executionFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 execution failed integrity verification');
  }
}

/**
 * Re-check the full execution contract whenever a later terminal record relies
 * on a retained execution. A valid event hash authenticates bytes, but it does
 * not by itself prove that those bytes satisfy the committed protocol.
 */
function executionSatisfiesStoredV2Protocol(
  protocol: CommittedCausalStudyProtocolV2,
  decision: CausalDecisionRecordV2,
  execution: CausalExecutionRecordV2,
): boolean {
  const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId);
  if (!arm
      || execution.studyId !== protocol.studyId
      || execution.protocolHash !== protocol.protocolHash
      || execution.decisionId !== decision.decisionId
      || execution.assignedExecutionPlanDigest !== arm.executionPlanDigest
      || execution.previousEventHash !== decision.eventHash
      || execution.startedAtMs < decision.assignedAtMs
      || execution.completedAtMs < execution.startedAtMs
      || execution.startedAtMs < protocol.studyWindow.startsAtMs
      || (protocol.studyWindow.endsAtMs !== null && execution.completedAtMs > protocol.studyWindow.endsAtMs)) {
    return false;
  }
  if (execution.adherence === 'confirmed'
      && (execution.actualExecutionPlanDigest === null
        || execution.actualExecutionPlanDigest !== execution.assignedExecutionPlanDigest)) {
    return false;
  }
  if ((execution.adherence === 'incomplete' || execution.adherence === 'unverifiable')
      && (execution.directAiCostUsd !== null || execution.fullArmCostUsd !== null)) {
    return false;
  }
  const direct = execution.directAiCostUsd;
  if (direct === null) {
    if (execution.directCostSourceClass !== 'incomplete_or_unknown') return false;
  } else if (direct < protocol.costOutcome.boundsUsd.low
      || direct > protocol.costOutcome.boundsUsd.high
      || (execution.directCostSourceClass !== 'actual_observed'
        && execution.directCostSourceClass !== 'actual_reconciled')
      || !protocol.costOutcome.acceptedSourceClasses.includes(
        execution.directCostSourceClass as 'actual_observed' | 'actual_reconciled',
      )
      || execution.priceLineageDigests.length === 0) {
    return false;
  }
  const full = execution.fullArmCostUsd;
  if (protocol.question === 'model_cost_quality') {
    if (full !== null || execution.fullCostSourceClass !== 'incomplete_or_unknown') return false;
  } else if (full === null
      || full < protocol.costOutcome.boundsUsd.low
      || full > protocol.costOutcome.boundsUsd.high
      || (execution.fullCostSourceClass !== 'actual_observed'
        && execution.fullCostSourceClass !== 'actual_reconciled')
      || !protocol.costOutcome.acceptedSourceClasses.includes(
        execution.fullCostSourceClass as 'actual_observed' | 'actual_reconciled',
      )
      || execution.priceLineageDigests.length === 0) {
    return false;
  }
  return true;
}

function normalizedExecutionError(error: unknown): Error {
  if (error instanceof CausalExecutionStoreError) return error;
  if (error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (code === 'CAUSAL_RECORD_INVALID') {
      return new CausalExecutionStoreError('CAUSAL_RECORD_INVALID', 'causal execution record is invalid');
    }
    if (code === 'CAUSAL_INTEGRITY_FAILURE') {
      return new CausalExecutionStoreError('CAUSAL_INTEGRITY_FAILURE', 'stored v2 causal evidence failed integrity verification');
    }
    if (code === 'CAUSAL_NOT_FOUND') {
      return new CausalExecutionStoreError('CAUSAL_RECORD_INVALID', 'causal execution record is invalid');
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new CausalExecutionStoreError('CAUSAL_BUSY', 'execution writer is busy; retry this immutable request');
  }
  if (/UNIQUE constraint failed.*causal_executions_v2/i.test(message)) {
    return new CausalExecutionStoreError('CAUSAL_IMMUTABLE_CONFLICT', 'causal execution conflicts with an existing immutable record');
  }
  return new CausalExecutionStoreError(
    'CAUSAL_APPEND_ROLLED_BACK',
    'execution transaction rolled back without disclosing a causal record',
  );
}

/**
 * Append one exact v2 execution record.  This is intentionally Store-internal:
 * terminal outcomes, public mutation, lifecycle, and analysis are separate
 * later increments.
 */
export function appendCausalExecutionV2(db: DatabaseSync, recordValue: unknown): 'created' | 'existing' {
  let committed = false;
  try {
    // Decode before property access, hashing, or database use.  All stateful
    // lineage and replay checks below remain inside the write transaction.
    const record = decodeCausalExecutionV2(recordValue);
    const encoded = canonicalJson(record);
    db.prepare('BEGIN IMMEDIATE').run();
    const protocol = requireProtocolV2(db, record.studyId);
    if (record.protocolHash !== protocol.protocolHash) {
      executionFail('CAUSAL_RECORD_INVALID', 'execution does not bind the stored v2 protocol');
    }

    // This scan authenticates the retained v2 assignment artifacts.  In
    // particular, no legacy causal_decisions row can become a predecessor.
    let blocks: CausalAssignmentBlockV2[];
    try {
      blocks = scanAssignmentArtifacts(db, protocol);
    } catch (error) {
      if (error instanceof CausalExecutionStoreError) throw error;
      executionFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment evidence failed integrity verification');
    }
    const decision = blocks.flatMap((block) => block.decisions)
      .find((candidate) => candidate.decisionId === record.decisionId);
    if (!decision) executionFail('CAUSAL_RECORD_INVALID', 'execution does not bind a stored v2 decision');
    const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId);
    if (!arm
        || record.assignedExecutionPlanDigest !== arm.executionPlanDigest
        || record.previousEventHash !== decision.eventHash
        || record.startedAtMs < decision.assignedAtMs) {
      executionFail('CAUSAL_RECORD_INVALID', 'execution lineage does not match the stored v2 decision');
    }
    if (record.startedAtMs < protocol.studyWindow.startsAtMs
        || (protocol.studyWindow.endsAtMs !== null && record.completedAtMs > protocol.studyWindow.endsAtMs)) {
      executionFail('CAUSAL_RECORD_INVALID', 'execution timestamps fall outside the stored study window');
    }
    const directCost = record.directAiCostUsd;
    if (directCost !== null && (!Number.isFinite(directCost)
        || directCost < protocol.costOutcome.boundsUsd.low
        || directCost > protocol.costOutcome.boundsUsd.high
        || !protocol.costOutcome.acceptedSourceClasses.includes(record.directCostSourceClass as 'actual_reconciled' | 'actual_observed'))) {
      executionFail('CAUSAL_RECORD_INVALID', 'execution does not satisfy the stored protocol');
    }
    const fullCost = record.fullArmCostUsd;
    if (protocol.question === 'model_cost_quality') {
      if (fullCost !== null || record.fullCostSourceClass !== 'incomplete_or_unknown') {
        executionFail('CAUSAL_RECORD_INVALID', 'execution does not satisfy the stored protocol');
      }
    } else {
      if (fullCost === null
          || !Number.isFinite(fullCost)
          || fullCost < protocol.costOutcome.boundsUsd.low
          || fullCost > protocol.costOutcome.boundsUsd.high
          || !protocol.costOutcome.acceptedSourceClasses.includes(record.fullCostSourceClass as 'actual_reconciled' | 'actual_observed')) {
        executionFail('CAUSAL_RECORD_INVALID', 'execution does not satisfy the stored protocol');
      }
    }

    const byIdRows = db.prepare(
      STORED_EXECUTION_V2_SELECT + 'FROM causal_executions_v2 WHERE execution_id = ?',
    ).all(record.executionId) as unknown as StoredExecutionV2Row[];
    if (byIdRows.length > 1) {
      executionFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 execution identity is duplicated');
    }
    const byId = byIdRows[0];
    if (byId) {
      const existing = authenticateStoredExecutionV2(byId);
      if (canonicalJson(existing) === encoded) {
        db.prepare('COMMIT').run();
        committed = true;
        return 'existing';
      }
      executionFail('CAUSAL_IMMUTABLE_CONFLICT', 'execution conflicts with existing immutable content');
    }

    // Authenticate any competing row before classifying a unique decision or
    // event collision.  A corrupt row is never an ordinary duplicate.
    const competing = db.prepare(
      STORED_EXECUTION_V2_SELECT + 'FROM causal_executions_v2 WHERE decision_id = ? OR event_hash = ?',
    ).all(record.decisionId, record.eventHash) as unknown as StoredExecutionV2Row[];
    for (const row of competing) authenticateStoredExecutionV2(row);
    if (competing.length > 0) {
      executionFail('CAUSAL_IMMUTABLE_CONFLICT', 'execution conflicts with an existing immutable decision or event');
    }

    db.prepare(
      'INSERT INTO causal_executions_v2 ' +
      '(execution_id, decision_id, study_id, protocol_hash, started_at_ms, completed_at_ms, previous_event_hash, event_hash, execution_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.executionId,
      record.decisionId,
      record.studyId,
      record.protocolHash,
      record.startedAtMs,
      record.completedAtMs,
      record.previousEventHash,
      record.eventHash,
      encoded,
    );

    const retainedRows = db.prepare(
      STORED_EXECUTION_V2_SELECT + 'FROM causal_executions_v2 WHERE execution_id = ?',
    ).all(record.executionId) as unknown as StoredExecutionV2Row[];
    if (retainedRows.length !== 1) {
      executionFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 execution identity did not reload exactly once');
    }
    const retained = retainedRows[0];
    if (!retained) executionFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 execution could not be reloaded');
    const authenticated = authenticateStoredExecutionV2(retained);
    if (canonicalJson(authenticated) !== encoded) {
      executionFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 execution did not replay canonically');
    }
    db.prepare('COMMIT').run();
    committed = true;
    return 'created';
  } catch (error) {
    if (!committed) {
      try { db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
    }
    throw normalizedExecutionError(error);
  }
}

interface StoredTerminalOutcomeV2Row {
  outcome_id: unknown;
  decision_id: unknown;
  study_id: unknown;
  protocol_hash: unknown;
  observed_at_ms_type: unknown;
  observed_at_ms_text: unknown;
  maturity: unknown;
  previous_event_hash: unknown;
  event_hash: unknown;
  terminal_outcome_json: unknown;
}

const STORED_TERMINAL_OUTCOME_V2_SELECT =
  'SELECT outcome_id, decision_id, study_id, protocol_hash, ' +
  'typeof(observed_at_ms) AS observed_at_ms_type, CAST(observed_at_ms AS TEXT) AS observed_at_ms_text, ' +
  'maturity, previous_event_hash, event_hash, terminal_outcome_json ';

class CausalTerminalOutcomeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'CausalTerminalOutcomeStoreError';
    this.code = code;
  }
}

function terminalOutcomeFail(code: string, message: string): never {
  throw new CausalTerminalOutcomeStoreError(code, message);
}

function authenticateStoredTerminalOutcomeV2(row: StoredTerminalOutcomeV2Row): CausalTerminalOutcomeRecordV2 {
  try {
    if (typeof row.terminal_outcome_json !== 'string') throw new Error('terminal outcome JSON storage class');
    const record = decodeCausalTerminalOutcomeV2(JSON.parse(row.terminal_outcome_json));
    if (row.terminal_outcome_json !== canonicalJson(record)) throw new Error('terminal outcome JSON is not canonical');
    const observedAtMs = decodeStoredIntegerMs(row.observed_at_ms_type, row.observed_at_ms_text);
    if (row.outcome_id !== record.outcomeId || row.decision_id !== record.decisionId
        || row.study_id !== record.studyId || row.protocol_hash !== record.protocolHash
        || observedAtMs !== record.observedAtMs || row.maturity !== record.maturity
        || row.previous_event_hash !== record.previousEventHash || row.event_hash !== record.eventHash) {
      throw new Error('terminal outcome physical identity');
    }
    return record;
  } catch {
    terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 terminal outcome failed integrity verification');
  }
}

function normalizedTerminalOutcomeError(error: unknown): Error {
  if (error instanceof CausalTerminalOutcomeStoreError) {
    if (error.code === 'CAUSAL_RECORD_INVALID' || error.code === 'CAUSAL_NOT_FOUND') {
      return new CausalTerminalOutcomeStoreError(
        'CAUSAL_RECORD_INVALID',
        'causal terminal outcome record is invalid',
      );
    }
    if (error.code === 'CAUSAL_INTEGRITY_FAILURE') {
      return new CausalTerminalOutcomeStoreError(
        'CAUSAL_INTEGRITY_FAILURE',
        'stored v2 terminal outcome failed integrity verification',
      );
    }
    return error;
  }
  if (error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (code === 'CAUSAL_RECORD_INVALID' || code === 'CAUSAL_NOT_FOUND') {
      return new CausalTerminalOutcomeStoreError(
        'CAUSAL_RECORD_INVALID',
        'causal terminal outcome record is invalid',
      );
    }
    if (code === 'CAUSAL_INTEGRITY_FAILURE') {
      return new CausalTerminalOutcomeStoreError(
        'CAUSAL_INTEGRITY_FAILURE',
        'stored v2 terminal outcome failed integrity verification',
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new CausalTerminalOutcomeStoreError(
      'CAUSAL_BUSY',
      'terminal outcome writer is busy; retry this immutable request',
    );
  }
  if (/UNIQUE constraint failed.*causal_terminal_outcomes_v2/i.test(message)) {
    return new CausalTerminalOutcomeStoreError(
      'CAUSAL_IMMUTABLE_CONFLICT',
      'terminal outcome conflicts with an existing immutable record',
    );
  }
  return new CausalTerminalOutcomeStoreError(
    'CAUSAL_APPEND_ROLLED_BACK',
    'terminal outcome transaction rolled back without disclosing a causal record',
  );
}

class CausalQualificationStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'CausalQualificationStoreError';
    this.code = code;
  }
}

function qualificationFail(code: string, message: string): never {
  throw new CausalQualificationStoreError(code, message);
}

function normalizedQualificationError(error: unknown): Error {
  if (error instanceof CausalQualificationStoreError) return error;
  if (error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (code === 'CAUSAL_NOT_FOUND') {
      return new CausalQualificationStoreError('CAUSAL_NOT_FOUND', 'committed causal study was not found');
    }
    if (code === 'CAUSAL_BUSY') {
      return new CausalQualificationStoreError('CAUSAL_BUSY', 'qualification reader is busy; retry this immutable read');
    }
    if (code === 'CAUSAL_INTEGRITY_FAILURE') {
      return new CausalQualificationStoreError(
        'CAUSAL_INTEGRITY_FAILURE',
        'stored v2 qualification evidence failed integrity verification',
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new CausalQualificationStoreError('CAUSAL_BUSY', 'qualification reader is busy; retry this immutable read');
  }
  return new CausalQualificationStoreError(
    'CAUSAL_INTEGRITY_FAILURE',
    'stored v2 qualification evidence failed integrity verification',
  );
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** The only production clock read used by V2 terminal operations. */
function readCausalWallClockMs(): number {
  return Date.now();
}

function readCausalClockFloor(db: DatabaseSync): number {
  try {
    const rows = db.prepare(
      'SELECT clock_id, typeof(last_wall_ms) AS wall_type, CAST(last_wall_ms AS TEXT) AS wall_text ' +
      'FROM causal_clock_state ORDER BY rowid',
    ).all() as Array<{ clock_id: unknown; wall_type: unknown; wall_text: unknown }>;
    if (rows.length !== 1) throw new Error('clock row cardinality');
    const row = rows[0]!;
    if (row.clock_id !== 'causal-v2' || row.wall_type !== 'integer'
        || typeof row.wall_text !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(row.wall_text)) {
      throw new Error('clock row shape');
    }
    const value = BigInt(row.wall_text);
    if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) throw new Error('clock floor range');
    return Number(value);
  } catch {
    terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 causal clock state failed integrity verification');
  }
}

function captureCausalAsOfMs(db: DatabaseSync): number {
  const nowMs = readCausalWallClockMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 causal clock state failed integrity verification');
  }
  const floor = readCausalClockFloor(db);
  if (nowMs < floor) {
    terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 causal clock state failed integrity verification');
  }
  return nowMs;
}

function advanceCausalClockFloor(db: DatabaseSync, nowMs: number): void {
  const result = db.prepare(
    "UPDATE causal_clock_state SET last_wall_ms = CASE WHEN last_wall_ms < ? THEN ? ELSE last_wall_ms END WHERE clock_id = 'causal-v2'",
  ).run(nowMs, nowMs);
  if (Number(result.changes) !== 1 || readCausalClockFloor(db) < nowMs) {
    terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 causal clock state failed integrity verification');
  }
}

type FollowUpDeadline =
  | { kind: 'legacy' }
  | { kind: 'valid'; deadlineMs: number }
  | { kind: 'impossible' };

function checkedFollowUpDeadlineMs(
  protocol: CommittedCausalStudyProtocolV2,
  completedAtMs: number,
): FollowUpDeadline {
  if (!Object.hasOwn(protocol, 'followUpWindowMs')) return { kind: 'legacy' };
  const followUpWindowMs = protocol.followUpWindowMs;
  if (typeof followUpWindowMs !== 'number'
      || !Number.isSafeInteger(followUpWindowMs) || followUpWindowMs <= 0
      || followUpWindowMs > 31_536_000_000
      || !Number.isSafeInteger(completedAtMs)
      || completedAtMs < 0
      || completedAtMs > Number.MAX_SAFE_INTEGER - followUpWindowMs) {
    return { kind: 'impossible' };
  }
  return { kind: 'valid', deadlineMs: completedAtMs + followUpWindowMs };
}

/** Append one exact v2 terminal outcome after an authenticated v2 execution. */
export function appendCausalTerminalOutcomeV2(
  db: DatabaseSync,
  recordValue: unknown,
): 'created' | 'existing' {
  let committed = false;
  try {
    const record = decodeCausalTerminalOutcomeV2(recordValue);
    const encoded = canonicalJson(record);
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      if (!causalV2SchemaComplete(db)) {
        terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 schema authority failed integrity verification');
      }
    } catch (error) {
      if (error instanceof CausalTerminalOutcomeStoreError) throw error;
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 schema authority failed integrity verification');
    }
    const asOfMs = captureCausalAsOfMs(db);

    const protocol = requireProtocolV2(db, record.studyId);
    if (record.protocolHash !== protocol.protocolHash) {
      terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
    }

    // Re-authenticate the V2 assignment lane so no legacy decision/outcome row
    // can become the predecessor for a terminal record.
    let blocks: CausalAssignmentBlockV2[];
    try {
      blocks = scanAssignmentArtifacts(db, protocol);
    } catch (error) {
      if (error instanceof CausalTerminalOutcomeStoreError) throw error;
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment evidence failed integrity verification');
    }
    const decision = blocks.flatMap((block) => block.decisions)
      .find((candidate) => candidate.decisionId === record.decisionId);
    if (!decision) terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');

    const executionRows = db.prepare(
      STORED_EXECUTION_V2_SELECT + 'FROM causal_executions_v2 WHERE decision_id = ?',
    ).all(record.decisionId) as unknown as StoredExecutionV2Row[];
    if (executionRows.length > 1) {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 execution predecessor identity is duplicated');
    }
    const executionRow = executionRows[0];
    if (!executionRow) terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
    const execution = authenticateStoredExecutionV2(executionRow);
    if (!executionSatisfiesStoredV2Protocol(protocol, decision, execution)) {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 execution failed protocol verification');
    }
    const followUpDeadline = checkedFollowUpDeadlineMs(protocol, execution.completedAtMs);
    if (followUpDeadline.kind === 'impossible') {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 follow-up policy failed integrity verification');
    }
    if (record.previousEventHash !== execution.eventHash
        || record.observedAtMs < execution.completedAtMs
        || record.observedAtMs > asOfMs) {
      terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
    }

    if (record.maturity === 'matured') {
      const quality = record.qualityValue;
      if (quality === null || quality < protocol.qualityOutcome.bounds.low
          || quality > protocol.qualityOutcome.bounds.high
          || record.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass
          || record.outcomeEvidenceDigests.length === 0) {
        terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
      }
      const economic = protocol.economicOutcome;
      if (protocol.question === 'model_cost_quality') {
        if (economic !== null || record.economicValueUsd !== null || record.economicEvidenceClass !== null) {
          terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
        }
      } else if (economic === null
          || record.economicValueUsd === null
          || record.economicValueUsd < economic.boundsUsd.low
          || record.economicValueUsd > economic.boundsUsd.high
          || record.economicEvidenceClass !== economic.evidenceClass) {
        terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
      }
    } else if (record.maturity === 'censored') {
      if (followUpDeadline.kind !== 'valid'
          || asOfMs < followUpDeadline.deadlineMs
          || record.observedAtMs < followUpDeadline.deadlineMs
          || record.observedAtMs > asOfMs) {
        terminalOutcomeFail('CAUSAL_RECORD_INVALID', 'causal terminal outcome record is invalid');
      }
    }

    const byIdRows = db.prepare(
      STORED_TERMINAL_OUTCOME_V2_SELECT + 'FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?',
    ).all(record.outcomeId) as unknown as StoredTerminalOutcomeV2Row[];
    if (byIdRows.length > 1) {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 terminal outcome identity is duplicated');
    }
    const byId = byIdRows[0];
    if (byId) {
      const existing = authenticateStoredTerminalOutcomeV2(byId);
      if (canonicalJson(existing) === encoded) {
        advanceCausalClockFloor(db, asOfMs);
        db.prepare('COMMIT').run();
        committed = true;
        return 'existing';
      }
      terminalOutcomeFail('CAUSAL_IMMUTABLE_CONFLICT', 'terminal outcome conflicts with existing immutable content');
    }

    const competing = db.prepare(
      STORED_TERMINAL_OUTCOME_V2_SELECT + 'FROM causal_terminal_outcomes_v2 WHERE decision_id = ? OR event_hash = ?',
    ).all(record.decisionId, record.eventHash) as unknown as StoredTerminalOutcomeV2Row[];
    for (const row of competing) authenticateStoredTerminalOutcomeV2(row);
    if (competing.length > 0) {
      terminalOutcomeFail('CAUSAL_IMMUTABLE_CONFLICT', 'terminal outcome conflicts with an existing immutable decision or event');
    }

    db.prepare(
      'INSERT INTO causal_terminal_outcomes_v2 ' +
      '(outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, maturity, previous_event_hash, event_hash, terminal_outcome_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.outcomeId,
      record.decisionId,
      record.studyId,
      record.protocolHash,
      record.observedAtMs,
      record.maturity,
      record.previousEventHash,
      record.eventHash,
      encoded,
    );

    const retainedRows = db.prepare(
      STORED_TERMINAL_OUTCOME_V2_SELECT + 'FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?',
    ).all(record.outcomeId) as unknown as StoredTerminalOutcomeV2Row[];
    if (retainedRows.length !== 1) {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 terminal outcome identity did not reload exactly once');
    }
    const retained = retainedRows[0];
    if (!retained) terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 terminal outcome could not be reloaded');
    const authenticated = authenticateStoredTerminalOutcomeV2(retained);
    if (canonicalJson(authenticated) !== encoded) {
      terminalOutcomeFail('CAUSAL_INTEGRITY_FAILURE', 'created v2 terminal outcome did not replay canonically');
    }
    advanceCausalClockFloor(db, asOfMs);
    db.prepare('COMMIT').run();
    committed = true;
    return 'created';
  } catch (error) {
    if (!committed) {
      try { db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
    }
    throw normalizedTerminalOutcomeError(error);
  }
}

/** Append a resolved/pending outcome only when it follows a stored execution. */
export function appendCausalOutcome(db: DatabaseSync, record: CausalOutcomeRecord): 'created' | 'existing' {
  const protocol = requireStoredProtocol(db, record.studyId, record.protocolHash);
  rejectLegacyMutation(protocol, 'append a version-1 outcome');
  const execution = [...db.prepare(
    'SELECT execution_id, event_hash, study_id, protocol_hash FROM causal_executions WHERE decision_id = ?',
  ).all(record.decisionId) as Array<{ execution_id: string; event_hash: string; study_id: string; protocol_hash: string }>]
    .find((candidate) =>
      candidate.event_hash === record.previousEventHash &&
      candidate.study_id === record.studyId &&
      candidate.protocol_hash === record.protocolHash,
    );
  if (!execution || !verifyCausalEvent(record as unknown as Record<string, unknown>)) {
    throw new Error('causal outcome does not follow its stored execution exactly');
  }
  const encoded = canonicalJson(record);
  const existing = db.prepare('SELECT outcome_json FROM causal_outcomes WHERE outcome_id = ?')
    .get(record.outcomeId) as { outcome_json: string } | undefined;
  if (existing) {
    if (existing.outcome_json === encoded) return 'existing';
    throw new Error('outcomeId is already recorded with different immutable content');
  }
  db.prepare(
    'INSERT INTO causal_outcomes (outcome_id, decision_id, study_id, protocol_hash, observed_at_ms, event_hash, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(record.outcomeId, record.decisionId, record.studyId, record.protocolHash, record.observedAtMs, record.eventHash, encoded);
  return 'created';
}

export function causalStudyData(db: DatabaseSync, studyId: string): CausalStudyData | null {
  const protocol = loadProtocol(db, studyId);
  if (!protocol) return null;
  if (protocol.version !== 1) return null;
  const decisions = db.prepare(
    'SELECT decision_json FROM causal_decisions WHERE study_id = ? ORDER BY assigned_at_ms, decision_id',
  ).all(studyId) as Array<{ decision_json: string }>;
  const executions = db.prepare(
    'SELECT execution_json FROM causal_executions WHERE study_id = ? ORDER BY completed_at_ms, execution_id',
  ).all(studyId) as Array<{ execution_json: string }>;
  const outcomes = db.prepare(
    'SELECT outcome_json FROM causal_outcomes WHERE study_id = ? ORDER BY observed_at_ms, outcome_id',
  ).all(studyId) as Array<{ outcome_json: string }>;
  return {
    protocol,
    decisions: decisions.map((row) => parseJson(row.decision_json, 'decision')),
    executions: executions.map((row) => parseJson(row.execution_json, 'execution')),
    outcomes: outcomes.map((row) => parseJson(row.outcome_json, 'outcome')),
  };
}

/** Store-owned v2 allocation: caller supplies no sequence, entropy, or plan. */
export function assignCausalBlockV2(
  db: DatabaseSync,
  request: CausalAssignmentRequestV2,
): CausalAssignmentResultV2 {
  return assignCausalBlockV2Store(db, request);
}

export function causalAssignmentManifestV2(
  db: DatabaseSync,
  studyId: string,
): CausalAssignmentManifestV2 | null {
  return readCausalAssignmentManifestV2Store(db, studyId);
}

function finiteStoredValue(value: number | null, bounds: { low: number; high: number }): boolean {
  return value !== null && Number.isFinite(value) && value >= bounds.low && value <= bounds.high;
}

interface AuthenticatedCausalStudySnapshotV2 extends CausalStudyDataV2 {
  lineageBindings: Array<{
    binding: CausalLineageBindingV2;
    validation: CausalLineageBindingValidationV2;
  }>;
}

const issuedV2QualificationSnapshots = new WeakSet<object>();

function freezeQualificationSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeQualificationSnapshot(child, seen);
  return Object.freeze(value);
}

function issueQualificationSnapshot(data: AuthenticatedCausalStudySnapshotV2): AuthenticatedCausalStudySnapshotV2 {
  const snapshot = JSON.parse(canonicalJson(data)) as AuthenticatedCausalStudySnapshotV2;
  freezeQualificationSnapshot(snapshot);
  issuedV2QualificationSnapshots.add(snapshot);
  return snapshot;
}

function blankQualificationCountsV2(armIds: string[]): Record<string, CausalQualificationV2['countsByArm'][string]> {
  return Object.fromEntries(armIds.map((armId) => [armId, {
    assigned: 0,
    pending: 0,
    completed: 0,
    censored: 0,
    invalid: 0,
  }]));
}

function structuralQualificationV2(
  data: CausalStudyDataV2,
  state: CausalQualificationV2['state'],
  reasons: string[],
  countsByArm: CausalQualificationV2['countsByArm'],
): CausalQualificationV2 {
  return {
    studyId: data.protocol.studyId,
    protocolHash: data.protocol.protocolHash,
    state,
    reasons,
    countsByArm,
  };
}

function duplicateQualificationIds(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function isQualificationDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

/**
 * Evaluate only structural V2 state after the Store has issued its immutable
 * authenticated snapshot. This function is intentionally module-private.
 */
function evaluateQualificationV2(data: AuthenticatedCausalStudySnapshotV2): CausalQualificationV2 {
  if (!issuedV2QualificationSnapshots.has(data)) {
    qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'authenticated v2 qualification snapshot is required');
  }
  const { protocol, decisions, executions, terminalOutcomes, lineageBindings } = data;
  const countsByArm = blankQualificationCountsV2(protocol.arms.map((arm) => arm.armId));
  const reasons: string[] = [];
  const protocolErrors = verifyCommittedCausalProtocol(protocol);
  if (protocolErrors.length > 0) {
    return structuralQualificationV2(data, 'invalid', ['invalid committed V2 protocol'], countsByArm);
  }

  const armIds = new Set(protocol.arms.map((arm) => arm.armId));
  const decisionById = new Map<string, CausalDecisionRecordV2>();
  if (duplicateQualificationIds(decisions.map((decision) => decision.decisionId))) {
    reasons.push('duplicate V2 assignment decision');
  }
  for (const decision of decisions) {
    if (decision.type !== 'fiscus.causal-decision'
        || decision.version !== 2
        || decision.studyId !== protocol.studyId
        || decision.protocolHash !== protocol.protocolHash
        || !isCausalIdentifier(decision.decisionId)
        || !isCausalIdentifier(decision.blockId)
        || !armIds.has(decision.assignedArmId)
        || !isQualificationDigest(decision.unitIdDigest)
        || !isQualificationDigest(decision.blockRoot)
        || !isQualificationDigest(decision.planHash)
        || !isQualificationDigest(decision.allocationHash)
        || !isQualificationDigest(decision.randomizationMaterialDigest)
        || !isQualificationDigest(decision.previousEventHash)
        || !isQualificationDigest(decision.eventHash)
        || decision.propensity !== protocol.allocation.probabilityPerArm
        || !Number.isSafeInteger(decision.assignedAtMs)
        || decision.assignedAtMs < protocol.committedAtMs) {
      reasons.push('invalid V2 assignment evidence');
      continue;
    }
    decisionById.set(decision.decisionId, decision);
    countsByArm[decision.assignedArmId]!.assigned += 1;
  }
  if (decisions.length === 0) {
    return structuralQualificationV2(data, 'collecting', ['V2 study has no assignment support'], countsByArm);
  }

  const executionByDecision = new Map<string, CausalExecutionRecordV2>();
  const invalidExecutionDecisions = new Set<string>();
  let unresolvedCostVerification = false;
  let missingLineageBinding = false;
  let invalidLineageBinding = false;
  const lineageByExecution = new Map<string, Array<{
    binding: CausalLineageBindingV2;
    validation: CausalLineageBindingValidationV2;
  }>>();
  const lineageBindingIds = new Set<string>();
  for (const lineage of lineageBindings) {
    if (lineageBindingIds.has(lineage.binding.bindingId)) invalidLineageBinding = true;
    lineageBindingIds.add(lineage.binding.bindingId);
    const related = lineageByExecution.get(lineage.binding.executionId) ?? [];
    related.push(lineage);
    lineageByExecution.set(lineage.binding.executionId, related);
    const validationAccepted = lineage.validation.state === 'valid'
      || (lineage.validation.state === 'invalid'
        && lineage.validation.reasonCodes.length === 1
        && lineage.validation.reasonCodes[0] === 'ledger_verification_unresolved');
    if (!validationAccepted) invalidLineageBinding = true;
  }
  if (duplicateQualificationIds(executions.map((execution) => execution.executionId))
      || duplicateQualificationIds(executions.map((execution) => execution.decisionId))) {
    reasons.push('duplicate V2 execution identity');
  }
  for (const execution of executions) {
    const decision = decisionById.get(execution.decisionId);
    const arm = decision && protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId);
    const valid = decision !== undefined && arm !== undefined
      && execution.type === 'fiscus.causal-execution'
      && execution.version === 2
      && execution.studyId === protocol.studyId
      && execution.protocolHash === protocol.protocolHash
      && isCausalIdentifier(execution.executionId)
      && execution.assignedExecutionPlanDigest === arm.executionPlanDigest
      && execution.actualExecutionPlanDigest === arm.executionPlanDigest
      && execution.adherence === 'confirmed'
      && execution.previousEventHash === decision.eventHash
      && Number.isSafeInteger(execution.startedAtMs)
      && Number.isSafeInteger(execution.completedAtMs)
      && execution.startedAtMs >= decision.assignedAtMs
      && execution.completedAtMs >= execution.startedAtMs
      && execution.startedAtMs >= protocol.studyWindow.startsAtMs
      && (protocol.studyWindow.endsAtMs === null || execution.completedAtMs <= protocol.studyWindow.endsAtMs)
      && execution.directAiCostUsd !== null
      && finiteStoredValue(execution.directAiCostUsd, protocol.costOutcome.boundsUsd)
      && (execution.directCostSourceClass === 'actual_observed' || execution.directCostSourceClass === 'actual_reconciled')
      && protocol.costOutcome.acceptedSourceClasses.includes(execution.directCostSourceClass)
      && execution.priceLineageDigests.length > 0
      && execution.priceLineageDigests.every(isQualificationDigest)
      && (protocol.question === 'model_cost_quality'
        ? execution.fullArmCostUsd === null
          && execution.fullCostSourceClass === 'incomplete_or_unknown'
        : execution.fullArmCostUsd !== null
          && finiteStoredValue(execution.fullArmCostUsd, protocol.costOutcome.boundsUsd)
          && (execution.fullCostSourceClass === 'actual_observed'
            || execution.fullCostSourceClass === 'actual_reconciled')
          && protocol.costOutcome.acceptedSourceClasses.includes(execution.fullCostSourceClass)
          && execution.priceLineageDigests.length > 0
          && execution.priceLineageDigests.every(isQualificationDigest));
    if (!valid) {
      reasons.push('invalid V2 execution evidence');
      invalidExecutionDecisions.add(execution.decisionId);
      continue;
    }
    if (execution.ordinaryLedgerVerifier.state === 'unresolved'
        && (execution.directAiCostUsd !== null || execution.fullArmCostUsd !== null)) {
      unresolvedCostVerification = true;
    }
    if (execution.directAiCostUsd !== null || execution.fullArmCostUsd !== null) {
      const related = lineageByExecution.get(execution.executionId) ?? [];
      if (related.length !== 1) missingLineageBinding = true;
    }
    executionByDecision.set(execution.decisionId, execution);
  }

  const terminalByDecision = new Map<string, CausalTerminalOutcomeRecordV2>();
  if (duplicateQualificationIds(terminalOutcomes.map((outcome) => outcome.outcomeId))
      || duplicateQualificationIds(terminalOutcomes.map((outcome) => outcome.decisionId))) {
    reasons.push('duplicate V2 terminal identity');
  }
  const invalidTerminalDecisions = new Set<string>();
  for (const outcome of terminalOutcomes) {
    const decision = decisionById.get(outcome.decisionId);
    const execution = executionByDecision.get(outcome.decisionId);
    const lineageValid = decision !== undefined && execution !== undefined
      && outcome.type === 'fiscus.causal-terminal-outcome'
      && outcome.version === 2
      && outcome.studyId === protocol.studyId
      && outcome.protocolHash === protocol.protocolHash
      && isCausalIdentifier(outcome.outcomeId)
      && outcome.previousEventHash === execution.eventHash
      && Number.isSafeInteger(outcome.observedAtMs)
      && outcome.observedAtMs >= execution.completedAtMs;
    if (!lineageValid) {
      reasons.push('invalid V2 terminal outcome evidence');
      invalidTerminalDecisions.add(outcome.decisionId);
      continue;
    }
    if (outcome.maturity === 'matured') {
      const qualityValid = finiteStoredValue(outcome.qualityValue, protocol.qualityOutcome.bounds)
        && outcome.qualityEvidenceClass === protocol.qualityOutcome.evidenceClass
        && outcome.outcomeEvidenceDigests.length > 0
        && outcome.outcomeEvidenceDigests.every(isQualificationDigest);
      const economic = protocol.economicOutcome;
      const economicValid = protocol.question === 'model_cost_quality'
        ? economic === null && outcome.economicValueUsd === null && outcome.economicEvidenceClass === null
        : economic !== null
          && finiteStoredValue(outcome.economicValueUsd, economic.boundsUsd)
          && outcome.economicEvidenceClass === economic.evidenceClass;
      if (!qualityValid || !economicValid) {
        reasons.push('invalid V2 matured outcome evidence');
        invalidTerminalDecisions.add(outcome.decisionId);
        continue;
      }
    } else if (outcome.maturity === 'censored') {
      if (!Object.hasOwn(protocol, 'followUpWindowMs')) {
        reasons.push('V2 censored outcome is unsupported without a committed follow-up policy');
        invalidTerminalDecisions.add(outcome.decisionId);
        continue;
      }
    } else if (outcome.maturity === 'invalid') {
      if (outcome.qualityValue !== null || outcome.qualityEvidenceClass !== null
          || outcome.economicValueUsd !== null || outcome.economicEvidenceClass !== null
          || outcome.outcomeEvidenceDigests.length !== 0 || outcome.invalidReason === null
          || outcome.censoredReason !== null) {
        reasons.push('invalid V2 invalid-outcome evidence');
        invalidTerminalDecisions.add(outcome.decisionId);
        continue;
      }
    } else {
      reasons.push('invalid V2 terminal maturity');
      invalidTerminalDecisions.add(outcome.decisionId);
      continue;
    }
    terminalByDecision.set(outcome.decisionId, outcome);
  }

  for (const decision of decisionById.values()) {
    const count = countsByArm[decision.assignedArmId]!;
    if (invalidExecutionDecisions.has(decision.decisionId)
        || invalidTerminalDecisions.has(decision.decisionId)) {
      count.invalid += 1;
      continue;
    }
    const terminal = terminalByDecision.get(decision.decisionId);
    if (!executionByDecision.has(decision.decisionId) || !terminal) {
      count.pending += 1;
      continue;
    }
    if (terminal.maturity === 'matured') count.completed += 1;
    else if (terminal.maturity === 'censored') count.censored += 1;
    else count.invalid += 1;
  }

  // A sidecar row is useful only when its three immutable anchors point to the
  // same retained decision/execution/outcome set.  Rows with a valid envelope
  // but a cross-study or orphaned anchor are invalid evidence, not harmless
  // extras.  The per-row semantic validation above also proves request and
  // scalar-realization digests against the current local ledger.
  for (const lineage of lineageBindings) {
    const binding = lineage.binding;
    const decision = decisionById.get(binding.decisionId);
    const execution = decision ? executionByDecision.get(decision.decisionId) : undefined;
    const outcome = decision ? terminalByDecision.get(decision.decisionId) : undefined;
    if (!decision || !execution || !outcome
        || binding.studyId !== protocol.studyId
        || binding.protocolHash !== protocol.protocolHash
        || binding.unitIdDigest !== decision.unitIdDigest
        || binding.executionId !== execution.executionId
        || binding.outcomeId !== outcome.outcomeId
        || binding.decisionId !== execution.decisionId) {
      invalidLineageBinding = true;
    }
  }

  if (invalidLineageBinding) reasons.push(CAUSAL_LINEAGE_BINDING_INVALID);

  if (Object.values(countsByArm).some((count) => count.invalid > 0)) {
    reasons.push('V2 invalid terminal outcome present');
  }
  if (reasons.length > 0) return structuralQualificationV2(data, 'invalid', reasons, countsByArm);
  if (Object.values(countsByArm).some((count) => count.pending > 0)) {
    return structuralQualificationV2(data, 'collecting', ['V2 terminal outcomes are still collecting'], countsByArm);
  }
  for (const count of Object.values(countsByArm)) {
    if (count.assigned > 0 && count.censored / count.assigned > protocol.analysis.maxMissingFractionPerArm) {
      reasons.push('V2 terminal missingness exceeds the committed limit');
    }
  }
  if (reasons.length > 0) return structuralQualificationV2(data, 'invalid', reasons, countsByArm);
  if (unresolvedCostVerification) {
    reasons.push('V2 ordinary ledger cost verification is unresolved');
  }
  if (missingLineageBinding) reasons.push(CAUSAL_LINEAGE_BINDING_NOT_PERSISTED);
  if (Object.values(countsByArm).some((count) => count.completed < protocol.analysis.minCompletedPerArm)) {
    reasons.push('V2 matured completion support is below the committed minimum');
  }
  if (reasons.length > 0) {
    return structuralQualificationV2(data, 'inconclusive', reasons, countsByArm);
  }
  return structuralQualificationV2(data, 'qualified', [], countsByArm);
}

function terminalOutcomeSatisfiesStoredV2Protocol(
  protocol: CommittedCausalStudyProtocolV2,
  execution: CausalExecutionRecordV2,
  outcome: CausalTerminalOutcomeRecordV2,
  asOfMs: number,
): boolean {
  if (outcome.studyId !== protocol.studyId
      || outcome.protocolHash !== protocol.protocolHash
      || outcome.decisionId !== execution.decisionId
      || outcome.previousEventHash !== execution.eventHash
      || !Number.isSafeInteger(outcome.observedAtMs)
      || outcome.observedAtMs < execution.completedAtMs
      || outcome.observedAtMs > asOfMs) {
    return false;
  }
  if (outcome.maturity === 'censored') {
    const deadline = checkedFollowUpDeadlineMs(protocol, execution.completedAtMs);
    return deadline.kind === 'legacy'
      || (deadline.kind === 'valid' && outcome.observedAtMs >= deadline.deadlineMs);
  }
  if (outcome.maturity !== 'matured') return true;
  if (!finiteStoredValue(outcome.qualityValue, protocol.qualityOutcome.bounds)
      || outcome.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass
      || outcome.outcomeEvidenceDigests.length === 0
      || !outcome.outcomeEvidenceDigests.every(digest)) {
    return false;
  }
  if (protocol.question === 'model_cost_quality') {
    return protocol.economicOutcome === null
      && outcome.economicValueUsd === null
      && outcome.economicEvidenceClass === null;
  }
  const economic = protocol.economicOutcome;
  return economic !== null
    && finiteStoredValue(outcome.economicValueUsd, economic.boundsUsd)
    && outcome.economicEvidenceClass === economic.evidenceClass;
}

/**
 * Read one coherent, authenticated V2 snapshot for the internal qualification
 * evaluator.  The manifest is the assignment authority; every retained
 * execution/outcome row is checked against that exact decision set, and
 * absence is preserved as pending rather than synthesized.
 */
export function causalQualificationV2(
  db: DatabaseSync,
  studyId: string,
): CausalQualificationV2 {
  if (!safeId(studyId)) {
    qualificationFail('CAUSAL_RECORD_INVALID', 'causal study id is invalid');
  }

  let committed = false;
  let transactionStarted = false;
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    transactionStarted = true;
    const asOfMs = captureCausalAsOfMs(db);
    if (!causalV2SchemaComplete(db)) {
      qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 qualification schema is not exact');
    }
    const protocol = requireProtocolV2(db, studyId);
    let blocks: CausalAssignmentBlockV2[];
    let manifest: CausalAssignmentManifestV2 | null;
    try {
      blocks = scanAssignmentArtifacts(db, protocol);
      manifest = retainedManifest(db, protocol);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error
          && (error as { code?: unknown }).code === 'CAUSAL_INTEGRITY_FAILURE') {
        throw error;
      }
      qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment evidence failed integrity verification');
    }

    const decisions = blocks.flatMap((block) => block.decisions);
    const decisionIds = decisions.map((decision) => decision.decisionId);
    if (new Set(decisionIds).size !== decisionIds.length) {
      qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment decisions contain duplicate identities');
    }
    if (manifest === null) {
      if (decisions.length !== 0) {
        qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignments have no authoritative manifest');
      }
    } else {
      if (manifest.studyId !== protocol.studyId
          || manifest.protocolHash !== protocol.protocolHash
          || manifest.decisionCount !== decisions.length
          || manifest.unitCount !== decisions.length
          || manifest.planCount !== blocks.length
          || manifest.decisions.length !== decisions.length) {
        qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment manifest cardinality is not authoritative');
      }
      for (const [index, decision] of decisions.entries()) {
        const manifestDecision = manifest.decisions[index];
        if (!manifestDecision
            || manifestDecision.decisionId !== decision.decisionId
            || manifestDecision.blockId !== decision.blockId
            || manifestDecision.blockSequence !== decision.blockSequence
            || manifestDecision.decisionIndex !== decision.decisionIndex
            || manifestDecision.unitIdDigest !== decision.unitIdDigest
            || manifestDecision.assignedArmId !== decision.assignedArmId
            || manifestDecision.eventHash !== decision.eventHash
            || manifestDecision.planHash !== decision.planHash) {
          qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 assignment manifest does not bind every decision');
        }
      }
    }

    const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
    const decisionPlaceholders = decisionIds.map(() => '?').join(', ');
    const executionRows = db.prepare(
      STORED_EXECUTION_V2_SELECT + 'FROM causal_executions_v2 WHERE study_id = ?'
        + (decisionIds.length > 0 ? ' OR decision_id IN (' + decisionPlaceholders + ')' : ''),
    ).all(studyId, ...decisionIds) as unknown as StoredExecutionV2Row[];
    const executions: CausalExecutionRecordV2[] = [];
    const executionByDecision = new Map<string, CausalExecutionRecordV2>();
    const executionIds = new Set<string>();
    for (const row of executionRows) {
      const execution = authenticateStoredExecutionV2(row);
      const decision = decisionById.get(execution.decisionId);
      if (!decision
          || execution.studyId !== protocol.studyId
          || execution.protocolHash !== protocol.protocolHash
          || executionIds.has(execution.executionId)
          || executionByDecision.has(execution.decisionId)
          || !executionSatisfiesStoredV2Protocol(protocol, decision, execution)) {
        qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 execution lineage is not authoritative');
      }
      if (checkedFollowUpDeadlineMs(protocol, execution.completedAtMs).kind === 'impossible') {
        qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 qualification evidence failed integrity verification');
      }
      executionIds.add(execution.executionId);
      executionByDecision.set(execution.decisionId, execution);
      executions.push(execution);
    }

    const terminalRows = db.prepare(
      STORED_TERMINAL_OUTCOME_V2_SELECT + 'FROM causal_terminal_outcomes_v2 WHERE study_id = ?'
        + (decisionIds.length > 0 ? ' OR decision_id IN (' + decisionPlaceholders + ')' : ''),
    ).all(studyId, ...decisionIds) as unknown as StoredTerminalOutcomeV2Row[];
    const terminalOutcomes: CausalTerminalOutcomeRecordV2[] = [];
    const terminalByDecision = new Map<string, CausalTerminalOutcomeRecordV2>();
    const outcomeIds = new Set<string>();
    for (const row of terminalRows) {
      const outcome = authenticateStoredTerminalOutcomeV2(row);
      const decision = decisionById.get(outcome.decisionId);
      const execution = executionByDecision.get(outcome.decisionId);
      if (!decision
          || !execution
          || outcome.studyId !== protocol.studyId
          || outcome.protocolHash !== protocol.protocolHash
          || outcomeIds.has(outcome.outcomeId)
          || terminalByDecision.has(outcome.decisionId)
          || !terminalOutcomeSatisfiesStoredV2Protocol(protocol, execution, outcome, asOfMs)) {
        qualificationFail('CAUSAL_INTEGRITY_FAILURE', 'stored v2 terminal outcome lineage is not authoritative');
      }
      outcomeIds.add(outcome.outcomeId);
      terminalByDecision.set(outcome.decisionId, outcome);
      terminalOutcomes.push(outcome);
    }

    // The sidecar is an authenticated Store-internal join, not a public
    // qualification input. Include rows whose identity points at this study's
    // decisions/executions/outcomes even when their stored study_id disagrees;
    // otherwise a cross-study transplant could masquerade as a missing row.
    const lineageBindings = causalLineageBindingsV2(db, studyId, {
      decisionIds,
      executionIds: [...executionIds],
      outcomeIds: [...outcomeIds],
    }).map((binding) => ({
      binding,
      validation: validateCausalLineageBindingV2(db, binding),
    }));

    const snapshot = issueQualificationSnapshot({
      protocol,
      decisions,
      executions,
      terminalOutcomes,
      lineageBindings,
    });
    const result = evaluateQualificationV2(snapshot);
    db.prepare('COMMIT').run();
    committed = true;
    return result;
  } catch (error) {
    if (transactionStarted && !committed) {
      try { db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
    }
    throw normalizedQualificationError(error);
  }
}

/** Stored randomisation blocks are retained for allocation replay and review. */
export function causalAssignmentPlans(db: DatabaseSync, studyId: string): CausalAssignmentPlan[] {
  return (db.prepare(
    'SELECT plan_json FROM causal_assignment_plans WHERE study_id = ? ORDER BY created_at_ms, block_id',
  ).all(studyId) as Array<{ plan_json: string }>).map((row) => parseJson(row.plan_json, 'assignment plan'));
}

export function saveCausalAnalysis(
  db: DatabaseSync,
  studyId: string,
  analysisId: string,
  computedAtMs = Date.now(),
): CausalAnalysisSnapshot {
  if (!isCausalIdentifier(analysisId) || !Number.isInteger(computedAtMs) || computedAtMs <= 0) {
    throw new Error('analysisId and computedAtMs must be valid local identifiers/timestamps');
  }
  const protocol = loadProtocol(db, studyId);
  if (protocol) rejectLegacyMutation(protocol, 'save a version-1 analysis snapshot');
  const data = causalStudyData(db, studyId);
  if (!data) throw new Error('causal study was not found');
  const estimate = estimateCausalStudy(data);
  const snapshot: CausalAnalysisSnapshot = { analysisId, computedAtMs, estimate };
  const encoded = canonicalJson(snapshot);
  const existing = db.prepare('SELECT analysis_json FROM causal_analysis_snapshots WHERE analysis_id = ?')
    .get(analysisId) as { analysis_json: string } | undefined;
  if (existing) {
    if (existing.analysis_json === encoded) return snapshot;
    throw new Error('analysisId is already recorded with different immutable content');
  }
  db.prepare(
    'INSERT INTO causal_analysis_snapshots (analysis_id, study_id, protocol_hash, computed_at_ms, state, analysis_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(analysisId, studyId, data.protocol.protocolHash, computedAtMs, estimate.qualification.state, encoded);
  return snapshot;
}

export function causalAnalysisSnapshots(db: DatabaseSync, studyId: string): CausalAnalysisSnapshot[] {
  return (db.prepare(
    'SELECT analysis_json FROM causal_analysis_snapshots WHERE study_id = ? ORDER BY computed_at_ms DESC, analysis_id DESC',
  ).all(studyId) as Array<{ analysis_json: string }>).map((row) => parseJson(row.analysis_json, 'analysis snapshot'));
}

export function causalStudySummaries(db: DatabaseSync): CausalStudySummary[] {
  const rows = db.prepare(
    'SELECT p.study_id, p.protocol_hash, typeof(p.committed_at_ms) AS committed_at_ms_type, ' +
    'CAST(p.committed_at_ms AS TEXT) AS committed_at_ms_text, p.protocol_json, ' +
    '(SELECT COUNT(*) FROM causal_decisions d WHERE d.study_id = p.study_id) AS decisions, ' +
    '(SELECT COUNT(*) FROM causal_executions e WHERE e.study_id = p.study_id) AS executions, ' +
    '(SELECT COUNT(*) FROM causal_outcomes o WHERE o.study_id = p.study_id) AS outcomes, ' +
    'a.analysis_id, a.analysis_at_type, a.analysis_at_text, a.analysis_state ' +
    'FROM causal_protocols p LEFT JOIN (' +
    'SELECT latest.study_id, latest.analysis_id, ' +
    'typeof(latest.computed_at_ms) AS analysis_at_type, ' +
    'CAST(latest.computed_at_ms AS TEXT) AS analysis_at_text, latest.state AS analysis_state ' +
    'FROM causal_analysis_snapshots latest WHERE latest.analysis_id = (' +
    'SELECT candidate.analysis_id FROM causal_analysis_snapshots candidate ' +
    'WHERE candidate.study_id = latest.study_id ' +
    'ORDER BY candidate.computed_at_ms DESC, candidate.analysis_id DESC LIMIT 1' +
    ')' +
    ') a ON a.study_id = p.study_id ' +
    'ORDER BY p.committed_at_ms DESC, p.study_id DESC',
  ).all() as Array<{
    study_id: unknown;
    protocol_hash: unknown;
    committed_at_ms_type: unknown;
    committed_at_ms_text: unknown;
    protocol_json: unknown;
    decisions: number;
    executions: number;
    outcomes: number;
    analysis_id: string | null;
    analysis_at_type: unknown;
    analysis_at_text: unknown;
    analysis_state: string | null;
  }>;
  return rows.flatMap((row) => {
    const decoded = decodeStoredProtocolRow(row);
    if (decoded.version === 2) return [];
    const protocol = decoded.protocol;
    const analysisAtMs = decodeStoredAnalysisAtMs(row);
    return [{
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      committedAtMs: protocol.committedAtMs,
      decisions: row.decisions,
      executions: row.executions,
      outcomes: row.outcomes,
      latestAnalysis: row.analysis_id !== null && analysisAtMs !== null && row.analysis_state
        ? { analysisId: row.analysis_id, computedAtMs: analysisAtMs, state: row.analysis_state }
        : null,
    }];
  });
}

// Version-2 assignment persistence is intentionally private to this module.
const ID_RE = /^[a-z][a-z0-9._-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENTROPY_BYTES = 32;
const INPUT_KEYS = ['blockId', 'sequence', 'createdAtMs', 'unitIdDigests', 'randomizationMaterial'] as const;
const REQUEST_KEYS = ['studyId', 'blockId', 'createdAtMs', 'unitIdDigests'] as const;
const PLAN_KEYS = [
  'type', 'version', 'studyId', 'blockId', 'protocolHash', 'sequence',
  'createdAtMs', 'blockRoot', 'unitIdDigests', 'randomizationMaterialDigest',
  'allocationHash', 'decisionIds', 'firstDecisionHash', 'lastDecisionHash',
  'planHash',
] as const;
const DECISION_KEYS = [
  'type', 'version', 'decisionId', 'studyId', 'blockId', 'protocolHash',
  'blockSequence', 'decisionIndex', 'unitIdDigest', 'assignedAtMs',
  'assignedArmId', 'propensity', 'blockRoot', 'planHash', 'allocationHash',
  'randomizationMaterialDigest', 'previousEventHash', 'eventHash',
] as const;

interface DerivationInputV2 {
  blockId: string;
  sequence: number;
  createdAtMs: number;
  unitIdDigests: string[];
  randomizationMaterial: Uint8Array;
}

class CausalAssignmentStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'CausalAssignmentStoreError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CausalAssignmentStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return Object.keys(value).every((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 160
    && ID_RE.test(value)
    && !/(?:bearer|basic)(?:[._-]|$)|api[_-]?key|secret|password|token|(?:^|:)(?:sk|rk|pk)-/i.test(value)
    && !/^[^.]+\.[^.]+\.[^.]+$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function exactRecord(
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
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(label + ' is missing required field: ' + key);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(label + ' has unsupported field: ' + key);
  }
  return true;
}

function uint64Be(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function domainHash(domain: string, material: unknown): string {
  return 'sha256:' + createHash('sha256')
    .update(domain + '\n2\n' + canonicalJson(material))
    .digest('hex');
}

function blockRoot(protocol: CommittedCausalStudyProtocolV2, blockId: string): string {
  return 'sha256:' + sha256(canonicalJson({
    domain: 'fiscus.causal.assignment-block-root',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
  }));
}

function materialDigest(material: Uint8Array): string {
  return 'sha256:' + createHash('sha256')
    .update(Buffer.from('fiscus.causal.randomization-material\n1\n'))
    .update(uint64Be(material.byteLength))
    .update(material)
    .digest('hex');
}

function decisionId(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  blockSequence: number,
  decisionIndex: number,
  unitIdDigest: string,
): string {
  return 'decision:' + sha256(canonicalJson({
    domain: 'fiscus.causal.decision-id',
    version: 1,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockSequence,
    decisionIndex,
    unitIdDigest,
  }));
}

function shuffledArms(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  root: string,
  sequence: number,
  unitIdDigests: string[],
  material: Uint8Array,
): string[] {
  const orderedArmIds = protocol.arms.map((arm) => arm.armId);
  const arms: string[] = [];
  const repetitions = unitIdDigests.length / orderedArmIds.length;
  for (const armId of orderedArmIds) {
    for (let index = 0; index < repetitions; index += 1) arms.push(armId);
  }
  const context = canonicalJson({
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockRoot: root,
    sequence,
    unitIdDigests,
    orderedArmIds,
  });
  let counter = 0;
  const nextWord = (): number => {
    const digestBytes = createHash('sha256')
      .update(Buffer.from('fiscus.causal.assignment-shuffle\n2\n'))
      .update(uint64Be(material.byteLength))
      .update(material)
      .update(uint64Be(Buffer.byteLength(context)))
      .update(context)
      .update(uint64Be(counter))
      .digest();
    try {
      const result = digestBytes.readUInt32BE(0);
      counter += 1;
      return result;
    } finally {
      digestBytes.fill(0);
    }
  };
  for (let index = arms.length - 1; index > 0; index -= 1) {
    const range = index + 1;
    const acceptanceLimit = Math.floor(0x1_0000_0000 / range) * range;
    let word = nextWord();
    while (word >= acceptanceLimit) word = nextWord();
    const swapIndex = word % range;
    const current = arms[index]!;
    arms[index] = arms[swapIndex]!;
    arms[swapIndex] = current;
  }
  return arms;
}

function allocationHash(
  protocol: CommittedCausalStudyProtocolV2,
  blockId: string,
  root: string,
  sequence: number,
  assignments: Array<{
    decisionIndex: number;
    unitIdDigest: string;
    assignedArmId: string;
    propensity: 0.5;
  }>,
  randomizationMaterialDigest: string,
): string {
  return domainHash('fiscus.causal.assignment-allocation', {
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId,
    blockRoot: root,
    sequence,
    assignments,
    randomizationMaterialDigest,
  });
}

function planHash(
  protocol: CommittedCausalStudyProtocolV2,
  material: {
    blockId: string;
    blockRoot: string;
    sequence: number;
    createdAtMs: number;
    randomizationMaterialDigest: string;
    allocationHash: string;
    unitIdDigests: string[];
    decisionIds: string[];
  },
): string {
  return domainHash('fiscus.causal.assignment-plan', {
    type: 'fiscus.causal-assignment-plan',
    version: 2,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    blockId: material.blockId,
    blockRoot: material.blockRoot,
    blockSequence: material.sequence,
    createdAtMs: material.createdAtMs,
    randomizationMaterialDigest: material.randomizationMaterialDigest,
    allocationHash: material.allocationHash,
    unitIdDigests: material.unitIdDigests,
    decisionIds: material.decisionIds,
    allocation: {
      method: protocol.allocation.method,
      blockSize: protocol.allocation.blockSize,
      probabilityPerArm: protocol.allocation.probabilityPerArm,
      orderedArmIds: protocol.arms.map((arm) => arm.armId),
    },
  });
}

function decisionHash(decision: Record<string, unknown>): string {
  const { eventHash: _eventHash, ...material } = decision;
  return domainHash('fiscus.causal.decision', material);
}

function validateDerivationInput(protocol: CommittedCausalStudyProtocolV2, input: unknown): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (protocol?.version !== 2) errors.push('v2 assignment requires a committed v2 protocol');
  if (errors.length > 0) return errors;
  if (!exactRecord(input, INPUT_KEYS, 'v2 assignment input', errors)) return errors;
  if (!safeId(input.blockId)) errors.push('blockId must be a safe namespaced identifier');
  if (!positiveSafeInteger(input.sequence)) errors.push('sequence must be a positive safe integer');
  if (!positiveSafeInteger(input.createdAtMs)) {
    errors.push('createdAtMs must be a positive safe-integer epoch timestamp');
  } else {
    if (input.createdAtMs < protocol.studyWindow.startsAtMs) errors.push('assignment must not precede the study window');
    if (protocol.studyWindow.endsAtMs !== null && input.createdAtMs > protocol.studyWindow.endsAtMs) {
      errors.push('assignment must not follow the study window');
    }
  }
  if (!denseArray(input.unitIdDigests)) {
    errors.push('unitIdDigests must be a dense ordered array');
  } else {
    if (input.unitIdDigests.length !== protocol.allocation.blockSize) {
      errors.push('unitIdDigests must contain exactly the committed protocol block size');
    }
    if (!input.unitIdDigests.every(digest)) errors.push('unitIdDigests must contain lowercase namespaced SHA-256 digests');
    if (new Set(input.unitIdDigests).size !== input.unitIdDigests.length) errors.push('unitIdDigests must be unique within the ordered block');
  }
  if (!(input.randomizationMaterial instanceof Uint8Array) || input.randomizationMaterial.byteLength !== ENTROPY_BYTES) {
    errors.push('randomization material must be exactly 32 raw bytes');
  }
  return errors;
}

/** Pure formula executor. It is reachable only through this non-package module. */
function deriveCausalAssignmentBlockV2Internal(
  protocol: CommittedCausalStudyProtocolV2,
  input: DerivationInputV2,
): CausalAssignmentBlockV2 {
  const errors = validateDerivationInput(protocol, input);
  if (errors.length > 0) throw new Error('cannot derive v2 blocked causal assignment: ' + errors.join('; '));

  const material = input.randomizationMaterial;
  const root = blockRoot(protocol, input.blockId);
  const randomizationMaterialDigest = materialDigest(material);
  const assignedArmIds = shuffledArms(protocol, input.blockId, root, input.sequence, input.unitIdDigests, material);
  const decisionIds = input.unitIdDigests.map((unitIdDigest, index) => decisionId(
    protocol,
    input.blockId,
    input.sequence,
    index + 1,
    unitIdDigest,
  ));
  const assignments = input.unitIdDigests.map((unitIdDigest, index) => ({
    decisionIndex: index + 1,
    unitIdDigest,
    assignedArmId: assignedArmIds[index]!,
    propensity: 0.5 as const,
  }));
  const allocation = allocationHash(protocol, input.blockId, root, input.sequence, assignments, randomizationMaterialDigest);
  const plan = planHash(protocol, {
    blockId: input.blockId,
    blockRoot: root,
    sequence: input.sequence,
    createdAtMs: input.createdAtMs,
    randomizationMaterialDigest,
    allocationHash: allocation,
    unitIdDigests: input.unitIdDigests,
    decisionIds,
  });

  const decisions: CausalDecisionRecordV2[] = [];
  let previousEventHash = root;
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index]!;
    const materialDecision: Omit<CausalDecisionRecordV2, 'eventHash'> = {
      type: 'fiscus.causal-decision',
      version: 2,
      decisionId: decisionIds[index]!,
      studyId: protocol.studyId,
      blockId: input.blockId,
      protocolHash: protocol.protocolHash,
      blockSequence: input.sequence,
      decisionIndex: index + 1,
      unitIdDigest: assignment.unitIdDigest,
      assignedAtMs: input.createdAtMs,
      assignedArmId: assignment.assignedArmId,
      propensity: 0.5,
      blockRoot: root,
      planHash: plan,
      allocationHash: allocation,
      randomizationMaterialDigest,
      previousEventHash,
    };
    const decision: CausalDecisionRecordV2 = {
      ...materialDecision,
      eventHash: decisionHash(materialDecision),
    };
    decisions.push(decision);
    previousEventHash = decision.eventHash;
  }

  return {
    plan: {
      type: 'fiscus.causal-assignment-plan',
      version: 2,
      studyId: protocol.studyId,
      blockId: input.blockId,
      protocolHash: protocol.protocolHash,
      sequence: input.sequence,
      createdAtMs: input.createdAtMs,
      blockRoot: root,
      unitIdDigests: [...input.unitIdDigests],
      randomizationMaterialDigest,
      allocationHash: allocation,
      decisionIds,
      firstDecisionHash: decisions[0]!.eventHash,
      lastDecisionHash: decisions.at(-1)!.eventHash,
      planHash: plan,
    },
    decisions,
  };
}

function validatePlanShape(plan: unknown, errors: string[]): plan is Record<string, unknown> {
  if (!exactRecord(plan, PLAN_KEYS, 'v2 assignment plan', errors)) return false;
  if (plan.type !== 'fiscus.causal-assignment-plan') errors.push('v2 assignment plan type is invalid');
  if (plan.version !== 2) errors.push('v2 assignment plan version is invalid');
  for (const [field, value] of [['studyId', plan.studyId], ['blockId', plan.blockId]] as const) {
    if (!safeId(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', plan.protocolHash], ['blockRoot', plan.blockRoot],
    ['randomizationMaterialDigest', plan.randomizationMaterialDigest],
    ['allocationHash', plan.allocationHash], ['firstDecisionHash', plan.firstDecisionHash],
    ['lastDecisionHash', plan.lastDecisionHash], ['planHash', plan.planHash],
  ] as const) {
    if (!digest(value)) errors.push('v2 assignment plan ' + field + ' is invalid');
  }
  if (!positiveSafeInteger(plan.sequence)) errors.push('v2 assignment plan sequence must be a positive safe integer');
  if (!positiveSafeInteger(plan.createdAtMs)) errors.push('v2 assignment plan createdAtMs must be a positive safe integer');
  if (!denseArray(plan.unitIdDigests) || !plan.unitIdDigests.every(digest)) {
    errors.push('v2 assignment plan unitIdDigests must be a dense digest array');
  } else if (new Set(plan.unitIdDigests).size !== plan.unitIdDigests.length) {
    errors.push('v2 assignment plan unitIdDigests contain a duplicate');
  }
  if (!denseArray(plan.decisionIds) || !plan.decisionIds.every(safeId)) {
    errors.push('v2 assignment plan decisionIds must be a dense namespaced-ID array');
  } else if (new Set(plan.decisionIds).size !== plan.decisionIds.length) {
    errors.push('v2 assignment plan decisionIds contain a duplicate');
  }
  return true;
}

function validateDecisionShape(decision: unknown, index: number, errors: string[]): decision is Record<string, unknown> {
  const label = 'v2 assignment decision[' + String(index) + ']';
  if (!exactRecord(decision, DECISION_KEYS, label, errors)) return false;
  if (decision.type !== 'fiscus.causal-decision') errors.push(label + ' type is invalid');
  if (decision.version !== 2) errors.push(label + ' version is invalid');
  for (const [field, value] of [
    ['decisionId', decision.decisionId], ['studyId', decision.studyId],
    ['blockId', decision.blockId], ['assignedArmId', decision.assignedArmId],
  ] as const) {
    if (!safeId(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  for (const [field, value] of [
    ['protocolHash', decision.protocolHash], ['unitIdDigest', decision.unitIdDigest],
    ['blockRoot', decision.blockRoot], ['planHash', decision.planHash],
    ['allocationHash', decision.allocationHash],
    ['randomizationMaterialDigest', decision.randomizationMaterialDigest],
    ['previousEventHash', decision.previousEventHash], ['eventHash', decision.eventHash],
  ] as const) {
    if (!digest(value)) errors.push(label + ' ' + field + ' is invalid');
  }
  if (!positiveSafeInteger(decision.blockSequence)) errors.push(label + ' blockSequence must be a positive safe integer');
  if (!positiveSafeInteger(decision.decisionIndex)) errors.push(label + ' decisionIndex must be a positive safe integer');
  if (!positiveSafeInteger(decision.assignedAtMs)) errors.push(label + ' assignedAtMs must be a positive safe integer');
  if (decision.propensity !== 0.5) errors.push(label + ' propensity must equal the committed protocol probability 0.5');
  return true;
}

/** Replay from Store-retained private entropy; not a supported package API. */
function verifyCausalAssignmentBlockV2Internal(
  protocol: unknown,
  block: unknown,
  randomizationMaterial: unknown,
): string[] {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (errors.length > 0) return errors;
  if (!isRecord(protocol) || protocol.version !== 2) {
    errors.push('v2 assignment replay requires a committed v2 protocol');
    return errors;
  }
  const protocolV2 = protocol as unknown as CommittedCausalStudyProtocolV2;
  if (!exactRecord(block, ['plan', 'decisions'], 'v2 assignment block', errors)) return errors;
  const planValid = validatePlanShape(block.plan, errors);
  if (!denseArray(block.decisions)) {
    errors.push('v2 assignment block decisions must be a dense ordered array');
    return errors;
  }
  const decisionsValid = block.decisions.map((decision, index) => validateDecisionShape(decision, index, errors));
  if (!(randomizationMaterial instanceof Uint8Array) || randomizationMaterial.byteLength !== ENTROPY_BYTES) {
    errors.push('retained private entropy must be exactly 32 raw bytes');
  }
  if (!planValid) return errors;

  const candidate = block.plan as Record<string, unknown>;
  if (candidate.studyId !== protocolV2.studyId) errors.push('assignment plan study identity does not match the committed protocol');
  if (candidate.protocolHash !== protocolV2.protocolHash) errors.push('assignment plan protocol identity does not match the committed protocol');
  if (Array.isArray(candidate.unitIdDigests) && candidate.unitIdDigests.length !== protocolV2.allocation.blockSize) {
    errors.push('assignment plan unit count does not match the committed protocol block size');
  }
  if (block.decisions.length !== (Array.isArray(candidate.unitIdDigests) ? candidate.unitIdDigests.length : -1)
      || block.decisions.length !== (Array.isArray(candidate.decisionIds) ? candidate.decisionIds.length : -1)) {
    errors.push('assignment plan↔decision bijection requires exactly one decision per ordered unit and decision ID');
  }
  const actualDecisionIds = block.decisions.filter(isRecord).map((decision) => decision.decisionId);
  if (new Set(actualDecisionIds).size !== actualDecisionIds.length) errors.push('assignment decisions contain a duplicate decisionId');

  const canDerive = safeId(candidate.blockId)
    && positiveSafeInteger(candidate.sequence)
    && positiveSafeInteger(candidate.createdAtMs)
    && denseArray(candidate.unitIdDigests)
    && candidate.unitIdDigests.length === protocolV2.allocation.blockSize
    && candidate.unitIdDigests.every(digest)
    && new Set(candidate.unitIdDigests).size === candidate.unitIdDigests.length
    && randomizationMaterial instanceof Uint8Array
    && randomizationMaterial.byteLength === ENTROPY_BYTES;
  if (!canDerive) return errors;
  const typedPlan = candidate as unknown as CausalAssignmentPlanV2;

  let expected: CausalAssignmentBlockV2;
  try {
    expected = deriveCausalAssignmentBlockV2Internal(protocolV2, {
      blockId: typedPlan.blockId,
      sequence: typedPlan.sequence,
      createdAtMs: typedPlan.createdAtMs,
      unitIdDigests: [...typedPlan.unitIdDigests],
      randomizationMaterial,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return errors;
  }

  if (typedPlan.blockRoot !== expected.plan.blockRoot) errors.push('assignment block root does not match its study/protocol/block domain');
  if (typedPlan.randomizationMaterialDigest !== expected.plan.randomizationMaterialDigest) {
    errors.push('assignment randomization material digest does not match retained private entropy');
  }
  if (typedPlan.allocationHash !== expected.plan.allocationHash) errors.push('assignment allocation hash does not replay');
  if (typedPlan.planHash !== expected.plan.planHash) errors.push('assignment plan hash does not replay');
  if (canonicalJson(typedPlan.unitIdDigests) !== canonicalJson(expected.plan.unitIdDigests)) {
    errors.push('assignment ordered unit digests do not replay');
  }
  if (canonicalJson(typedPlan.decisionIds) !== canonicalJson(expected.plan.decisionIds)) {
    errors.push('assignment decisionIds do not preserve the plan↔decision bijection and order');
  }
  if (typedPlan.firstDecisionHash !== expected.plan.firstDecisionHash) errors.push('assignment first decision anchor does not replay');
  if (typedPlan.lastDecisionHash !== expected.plan.lastDecisionHash) errors.push('assignment last decision anchor does not replay');

  for (let index = 0; index < block.decisions.length; index += 1) {
    const decision = block.decisions[index];
    if (!decisionsValid[index] || !isRecord(decision)) continue;
    const expectedDecision = expected.decisions[index];
    if (!expectedDecision) {
      errors.push('assignment decision[' + String(index) + '] has no plan entry');
      continue;
    }
    const label = 'assignment decision[' + String(index) + ']';
    if (decision.decisionId !== typedPlan.decisionIds[index]) errors.push(label + ' violates the ordered plan↔decision bijection');
    if (decision.decisionIndex !== index + 1) errors.push(label + ' decisionIndex is not gap-free plan order');
    if (decision.unitIdDigest !== typedPlan.unitIdDigests[index]) errors.push(label + ' unit digest does not match plan order');
    if (decision.studyId !== protocolV2.studyId || decision.protocolHash !== protocolV2.protocolHash) {
      errors.push(label + ' study/protocol identity is contradictory');
    }
    if (decision.blockId !== typedPlan.blockId || decision.blockSequence !== typedPlan.sequence) {
      errors.push(label + ' block identity or sequence is contradictory');
    }
    if (decision.blockRoot !== typedPlan.blockRoot) errors.push(label + ' block root is contradictory');
    if (decision.randomizationMaterialDigest !== typedPlan.randomizationMaterialDigest) errors.push(label + ' material digest is contradictory');
    if (decision.allocationHash !== typedPlan.allocationHash) errors.push(label + ' allocation hash is contradictory');
    if (decision.planHash !== typedPlan.planHash) errors.push(label + ' plan hash is contradictory');
    if (decision.assignedAtMs !== typedPlan.createdAtMs) errors.push(label + ' assignedAtMs must equal assignment plan createdAtMs');
    const previousDecision = block.decisions[index - 1];
    const expectedPredecessor = index === 0
      ? typedPlan.blockRoot
      : isRecord(previousDecision) ? previousDecision.eventHash : undefined;
    if (decision.previousEventHash !== expectedPredecessor) errors.push(label + ' immediate predecessor is invalid');
    if (decision.eventHash !== decisionHash(decision)) errors.push(label + ' event hash does not verify');
    if (canonicalJson(decision) !== canonicalJson(expectedDecision)) errors.push(label + ' does not replay from the retained entropy and protocol');
  }

  const firstActual = block.decisions[0];
  const lastActual = block.decisions.at(-1);
  const firstHash = isRecord(firstActual) ? firstActual.eventHash : undefined;
  const lastHash = isRecord(lastActual) ? lastActual.eventHash : undefined;
  if (typedPlan.firstDecisionHash !== firstHash) errors.push('assignment firstDecisionHash is not the derived first decision anchor');
  if (typedPlan.lastDecisionHash !== lastHash) errors.push('assignment lastDecisionHash is not the derived last decision anchor');
  return errors;
}

function parseV2Json(raw: unknown, label: string): unknown {
  if (typeof raw !== 'string') {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored ' + label + ' is not canonical JSON text');
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored ' + label + ' is malformed');
  }
}

function requireProtocolV2(db: DatabaseSync, studyId: string): CommittedCausalStudyProtocolV2 {
  const row = db.prepare(
    STORED_PROTOCOL_SELECT + 'FROM causal_protocols WHERE study_id = ?',
  ).get(studyId) as StoredProtocolRow | undefined;
  if (!row) fail('CAUSAL_NOT_FOUND', 'committed causal study was not found');
  const decoded = decodeStoredProtocolRow(row);
  if (decoded.version !== 2) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored assignment protocol is not an exact committed v2 protocol');
  }
  return decoded.protocol;
}

function validateRequest(protocol: CommittedCausalStudyProtocolV2, request: unknown): CausalAssignmentRequestV2 {
  const errors: string[] = [];
  if (!exactRecord(request, REQUEST_KEYS, 'v2 assignment request', errors)) {
    fail('CAUSAL_ASSIGNMENT_INVALID', errors.join('; '));
  }
  if (!safeId(request.studyId) || request.studyId !== protocol.studyId) errors.push('studyId must exactly identify the stored protocol');
  if (!safeId(request.blockId)) errors.push('blockId must be a safe namespaced identifier');
  if (!positiveSafeInteger(request.createdAtMs)) {
    errors.push('createdAtMs must be a positive safe-integer epoch timestamp');
  } else {
    if (request.createdAtMs < protocol.studyWindow.startsAtMs) errors.push('assignment must not precede the study window');
    if (protocol.studyWindow.endsAtMs !== null && request.createdAtMs > protocol.studyWindow.endsAtMs) {
      errors.push('assignment must not follow the study window');
    }
  }
  if (!denseArray(request.unitIdDigests)) {
    errors.push('unitIdDigests must be a dense ordered array');
  } else {
    if (request.unitIdDigests.length !== protocol.allocation.blockSize) errors.push('unitIdDigests must equal the committed block size');
    if (!request.unitIdDigests.every(digest)) errors.push('unitIdDigests must be lowercase namespaced SHA-256 digests');
    if (new Set(request.unitIdDigests).size !== request.unitIdDigests.length) errors.push('unitIdDigests must be unique within the block');
  }
  if (errors.length > 0) fail('CAUSAL_ASSIGNMENT_INVALID', errors.join('; '));
  return request as unknown as CausalAssignmentRequestV2;
}

interface PlanRowV2 {
  study_id: string;
  block_id: string;
  protocol_hash: string;
  sequence: number;
  created_at_ms: number;
  block_root: string;
  allocation_hash: string;
  material_digest: string;
  plan_hash: string;
  entropy_blob: unknown;
  plan_json: unknown;
}

interface DecisionRowV2 {
  decision_id: string;
  study_id: string;
  block_id: string;
  block_sequence: number;
  decision_index: number;
  unit_id_digest: string;
  assigned_arm_id: string;
  event_hash: string;
  decision_json: unknown;
}

interface UnitRowV2 {
  study_id: string;
  unit_id_digest: string;
  decision_id: string;
  block_id: string;
  block_sequence: number;
  claimed_at_ms: number;
}

interface ManifestRowV2 {
  study_id: string;
  generation: number;
  protocol_hash: string;
  manifest_hash: string;
  manifest_json: unknown;
}

const MANIFEST_KEYS = [
  'type', 'version', 'studyId', 'protocolHash', 'planCount', 'decisionCount',
  'unitCount', 'plans', 'decisions', 'assignmentManifestHash',
] as const;
const MANIFEST_PLAN_KEYS = [
  'blockId', 'sequence', 'blockRoot', 'planHash', 'allocationHash',
  'firstDecisionHash', 'lastDecisionHash', 'decisionCount',
] as const;
const MANIFEST_DECISION_KEYS = [
  'decisionId', 'blockId', 'blockSequence', 'decisionIndex', 'unitIdDigest',
  'assignedArmId', 'eventHash', 'planHash',
] as const;

function validateManifestShape(value: unknown): asserts value is CausalAssignmentManifestV2 {
  const errors: string[] = [];
  if (!exactRecord(value, MANIFEST_KEYS, 'v2 assignment manifest', errors)) {
    fail('CAUSAL_INTEGRITY_FAILURE', errors.join('; '));
  }
  if (value.type !== 'fiscus.causal-assignment-manifest' || value.version !== 2
      || !safeId(value.studyId) || !digest(value.protocolHash)
      || !positiveSafeInteger(value.planCount) || !positiveSafeInteger(value.decisionCount)
      || !positiveSafeInteger(value.unitCount) || !digest(value.assignmentManifestHash)
      || !denseArray(value.plans) || !denseArray(value.decisions)) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored assignment manifest scalar or array shape is invalid');
  }
  for (const [index, plan] of value.plans.entries()) {
    if (!exactRecord(plan, MANIFEST_PLAN_KEYS, 'v2 assignment manifest plan[' + String(index) + ']', errors)) continue;
    if (!safeId(plan.blockId) || !positiveSafeInteger(plan.sequence) || !digest(plan.blockRoot)
        || !digest(plan.planHash) || !digest(plan.allocationHash) || !digest(plan.firstDecisionHash)
        || !digest(plan.lastDecisionHash) || !positiveSafeInteger(plan.decisionCount)) {
      errors.push('v2 assignment manifest plan[' + String(index) + '] is invalid');
    }
  }
  for (const [index, decision] of value.decisions.entries()) {
    if (!exactRecord(decision, MANIFEST_DECISION_KEYS, 'v2 assignment manifest decision[' + String(index) + ']', errors)) continue;
    if (!safeId(decision.decisionId) || !safeId(decision.blockId)
        || !positiveSafeInteger(decision.blockSequence) || !positiveSafeInteger(decision.decisionIndex)
        || !digest(decision.unitIdDigest) || !safeId(decision.assignedArmId)
        || !digest(decision.eventHash) || !digest(decision.planHash)) {
      errors.push('v2 assignment manifest decision[' + String(index) + '] is invalid');
    }
  }
  if (errors.length > 0) fail('CAUSAL_INTEGRITY_FAILURE', errors.join('; '));
}

function canonicalPlan(raw: unknown): CausalAssignmentPlanV2 {
  const value = parseV2Json(raw, 'causal assignment plan');
  const errors: string[] = [];
  if (!validatePlanShape(value, errors) || errors.length > 0) {
    fail('CAUSAL_INTEGRITY_FAILURE', errors.join('; ') || 'stored assignment plan shape is invalid');
  }
  if (raw !== canonicalJson(value)) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored causal assignment plan JSON is not canonical');
  }
  return value as unknown as CausalAssignmentPlanV2;
}

function canonicalDecision(raw: unknown, index: number): CausalDecisionRecordV2 {
  const value = parseV2Json(raw, 'causal assignment decision');
  const errors: string[] = [];
  if (!validateDecisionShape(value, index, errors) || errors.length > 0) {
    fail('CAUSAL_INTEGRITY_FAILURE', errors.join('; ') || 'stored assignment decision shape is invalid');
  }
  if (raw !== canonicalJson(value)) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored causal assignment decision JSON is not canonical');
  }
  return value as unknown as CausalDecisionRecordV2;
}

function canonicalManifest(raw: unknown): CausalAssignmentManifestV2 {
  const value = parseV2Json(raw, 'causal assignment manifest');
  validateManifestShape(value);
  if (raw !== canonicalJson(value)) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored causal assignment manifest JSON is not canonical');
  }
  return value;
}

function mutableBlob(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'stored ' + label + ' is not a byte BLOB');
  }
  return value;
}

function zeroizeMutableBlob(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
}

function loadBlockByPlanRow(
  db: DatabaseSync,
  row: { plan_json: unknown; entropy_blob: unknown },
): { block: CausalAssignmentBlockV2; entropy: Buffer } {
  const plan = canonicalPlan(row.plan_json);
  const decisions = (db.prepare(
    'SELECT decision_json FROM causal_decisions_v2 WHERE study_id = ? AND block_sequence = ? ORDER BY decision_index',
  ).all(plan.studyId, plan.sequence) as Array<{ decision_json: unknown }>).map(
    (decision, index) => canonicalDecision(decision.decision_json, index),
  );
  const retainedEntropy = mutableBlob(row.entropy_blob, 'causal assignment entropy');
  let entropy: Buffer;
  try {
    entropy = Buffer.from(retainedEntropy);
  } finally {
    retainedEntropy.fill(0);
  }
  return { block: { plan, decisions }, entropy };
}

function manifestFromBlocks(
  protocol: CommittedCausalStudyProtocolV2,
  blocks: CausalAssignmentBlockV2[],
): CausalAssignmentManifestV2 {
  const plans = blocks.map(({ plan, decisions }) => ({
    blockId: plan.blockId,
    sequence: plan.sequence,
    blockRoot: plan.blockRoot,
    planHash: plan.planHash,
    allocationHash: plan.allocationHash,
    firstDecisionHash: plan.firstDecisionHash,
    lastDecisionHash: plan.lastDecisionHash,
    decisionCount: decisions.length,
  }));
  const decisions = blocks.flatMap((block) => block.decisions.map((decision) => ({
    decisionId: decision.decisionId,
    blockId: decision.blockId,
    blockSequence: decision.blockSequence,
    decisionIndex: decision.decisionIndex,
    unitIdDigest: decision.unitIdDigest,
    assignedArmId: decision.assignedArmId,
    eventHash: decision.eventHash,
    planHash: decision.planHash,
  })));
  const material = {
    type: 'fiscus.causal-assignment-manifest' as const,
    version: 2 as const,
    studyId: protocol.studyId,
    protocolHash: protocol.protocolHash,
    planCount: plans.length,
    decisionCount: decisions.length,
    unitCount: decisions.length,
    plans,
    decisions,
  };
  return { ...material, assignmentManifestHash: domainHash('fiscus.causal.assignment-manifest', material) };
}

function scanAssignmentArtifacts(
  db: DatabaseSync,
  protocol: CommittedCausalStudyProtocolV2,
): CausalAssignmentBlockV2[] {
  const plans = db.prepare(
    'SELECT study_id, block_id, protocol_hash, sequence, created_at_ms, block_root, allocation_hash, material_digest, plan_hash, entropy_blob, plan_json ' +
    'FROM causal_assignment_plans_v2 WHERE study_id = ? ORDER BY sequence',
  ).all(protocol.studyId) as unknown as PlanRowV2[];
  const decisions = db.prepare(
    'SELECT decision_id, study_id, block_id, block_sequence, decision_index, unit_id_digest, assigned_arm_id, event_hash, decision_json ' +
    'FROM causal_decisions_v2 WHERE study_id = ? ORDER BY block_sequence, decision_index',
  ).all(protocol.studyId) as unknown as DecisionRowV2[];
  const units = db.prepare(
    'SELECT study_id, unit_id_digest, decision_id, block_id, block_sequence, claimed_at_ms ' +
    'FROM causal_assignment_units_v2 WHERE study_id = ? ORDER BY block_sequence, decision_id',
  ).all(protocol.studyId) as unknown as UnitRowV2[];
  try {
    const blocks: CausalAssignmentBlockV2[] = [];
    let consumedDecisions = 0;

  for (let index = 0; index < plans.length; index += 1) {
    const row = plans[index]!;
    const expectedSequence = index + 1;
    const plan = canonicalPlan(row.plan_json);
    if (row.study_id !== protocol.studyId || row.protocol_hash !== protocol.protocolHash
        || row.block_id !== plan.blockId || row.sequence !== plan.sequence || row.sequence !== expectedSequence
        || row.created_at_ms !== plan.createdAtMs || row.block_root !== plan.blockRoot
        || row.allocation_hash !== plan.allocationHash || row.material_digest !== plan.randomizationMaterialDigest
        || row.plan_hash !== plan.planHash) {
      fail('CAUSAL_INTEGRITY_FAILURE', 'assignment plan physical columns contradict exact plan JSON or sequence');
    }
    const decisionRows = decisions.filter((decision) => decision.block_sequence === expectedSequence);
    const decoded = decisionRows.map((decisionRow, decisionIndex) => {
      const decision = canonicalDecision(decisionRow.decision_json, decisionIndex);
      if (decisionRow.decision_id !== decision.decisionId || decisionRow.study_id !== decision.studyId
          || decisionRow.block_id !== decision.blockId || decisionRow.block_sequence !== decision.blockSequence
          || decisionRow.decision_index !== decision.decisionIndex || decisionRow.decision_index !== decisionIndex + 1
          || decisionRow.unit_id_digest !== decision.unitIdDigest || decisionRow.assigned_arm_id !== decision.assignedArmId
          || decisionRow.event_hash !== decision.eventHash) {
        fail('CAUSAL_INTEGRITY_FAILURE', 'assignment decision physical columns contradict exact decision JSON or order');
      }
      return decision;
    });
    consumedDecisions += decisionRows.length;
    const retainedEntropy = mutableBlob(row.entropy_blob, 'causal assignment entropy');
    let entropy: Buffer;
    try {
      entropy = Buffer.from(retainedEntropy);
    } finally {
      retainedEntropy.fill(0);
    }
    try {
      const block = { plan, decisions: decoded };
      const errors = verifyCausalAssignmentBlockV2Internal(protocol, block, entropy);
      if (errors.length > 0) fail('CAUSAL_INTEGRITY_FAILURE', errors.join('; '));
      blocks.push(block);
    } finally {
      entropy.fill(0);
    }
  }

  if (consumedDecisions !== decisions.length) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'assignment decision table contains orphan or extra rows');
  }
  const expectedDecisions = blocks.flatMap((block) => block.decisions);
  if (units.length !== expectedDecisions.length) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'assignment unit claims do not form a complete decision bijection');
  }
  const claimByDecision = new Map(units.map((unit) => [unit.decision_id, unit]));
  if (claimByDecision.size !== units.length) fail('CAUSAL_INTEGRITY_FAILURE', 'assignment unit claims contain duplicates');
  for (const decision of expectedDecisions) {
    const claim = claimByDecision.get(decision.decisionId);
    if (!claim || claim.study_id !== protocol.studyId || claim.unit_id_digest !== decision.unitIdDigest
        || claim.block_id !== decision.blockId || claim.block_sequence !== decision.blockSequence
        || claim.claimed_at_ms !== decision.assignedAtMs) {
      fail('CAUSAL_INTEGRITY_FAILURE', 'assignment unit claim physical row contradicts its exact decision');
    }
  }
    return blocks;
  } finally {
    // node:sqlite returns mutable JS BLOB views. Clear every returned view,
    // including rows not reached when exact decoding fails early.
    for (const row of plans) zeroizeMutableBlob(row.entropy_blob);
  }
}

function recomputeManifest(
  db: DatabaseSync,
  protocol: CommittedCausalStudyProtocolV2,
): CausalAssignmentManifestV2 {
  return manifestFromBlocks(protocol, scanAssignmentArtifacts(db, protocol));
}

function retainedManifest(
  db: DatabaseSync,
  protocol: CommittedCausalStudyProtocolV2,
): CausalAssignmentManifestV2 | null {
  const blocks = scanAssignmentArtifacts(db, protocol);
  const rows = db.prepare(
    'SELECT study_id, generation, protocol_hash, manifest_hash, manifest_json ' +
    'FROM causal_assignment_manifests_v2 WHERE study_id = ? ORDER BY generation',
  ).all(protocol.studyId) as unknown as ManifestRowV2[];
  if (blocks.length === 0) {
    if (rows.length !== 0) fail('CAUSAL_INTEGRITY_FAILURE', 'first assignment requires zero prior manifest rows');
    return null;
  }
  if (rows.length !== blocks.length) {
    fail('CAUSAL_INTEGRITY_FAILURE', 'assignment manifest generations are missing or extra');
  }
  let current: CausalAssignmentManifestV2 | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const generation = index + 1;
    const stored = canonicalManifest(row.manifest_json);
    const expected = manifestFromBlocks(protocol, blocks.slice(0, generation));
    if (row.study_id !== protocol.studyId || row.generation !== generation
        || row.protocol_hash !== protocol.protocolHash || row.manifest_hash !== stored.assignmentManifestHash
        || row.manifest_hash !== expected.assignmentManifestHash
        || canonicalJson(stored) !== canonicalJson(expected)) {
      fail('CAUSAL_INTEGRITY_FAILURE', 'stored assignment manifest generation or physical columns are not authoritative');
    }
    current = expected;
  }
  return current;
}

function currentManifest(db: DatabaseSync, protocol: CommittedCausalStudyProtocolV2): CausalAssignmentManifestV2 {
  const current = retainedManifest(db, protocol);
  if (!current) fail('CAUSAL_INTEGRITY_FAILURE', 'assignment manifest is missing');
  return current;
}

function normalizedAssignmentError(error: unknown): Error {
  if (error instanceof CausalAssignmentStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new CausalAssignmentStoreError('CAUSAL_BUSY', 'assignment writer is busy; retry this immutable request');
  }
  if (/UNIQUE constraint failed.*causal_assignment_units_v2/i.test(message)) {
    return new CausalAssignmentStoreError('CAUSAL_UNIT_ALREADY_ASSIGNED', 'one or more unit digests are already assigned in this study');
  }
  return new CausalAssignmentStoreError(
    'CAUSAL_ASSIGNMENT_ROLLED_BACK',
    'assignment transaction rolled back without disclosing an allocation',
  );
}

function assignCausalBlockV2Store(
  db: DatabaseSync,
  requestValue: unknown,
): CausalAssignmentResultV2 {
  let entropy: Buffer | null = null;
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    const requestRoot = isRecord(requestValue) ? requestValue.studyId : undefined;
    if (!safeId(requestRoot)) fail('CAUSAL_ASSIGNMENT_INVALID', 'studyId must be a safe namespaced identifier');
    const protocol = requireProtocolV2(db, requestRoot);
    const request = validateRequest(protocol, requestValue);
    // Audit every retained row and exact manifest generation before any new
    // cryptographic entropy is allocated. The first assignment is valid only
    // when all four v2 artifact tables are empty for the study.
    const previousManifest = retainedManifest(db, protocol);

    const existingRow = db.prepare(
      'SELECT plan_json, entropy_blob FROM causal_assignment_plans_v2 WHERE study_id = ? AND block_id = ?',
    ).get(request.studyId, request.blockId) as { plan_json: unknown; entropy_blob: unknown } | undefined;
    if (existingRow) {
      const loaded = loadBlockByPlanRow(db, existingRow);
      try {
        const sameIntent = loaded.block.plan.createdAtMs === request.createdAtMs
          && canonicalJson(loaded.block.plan.unitIdDigests) === canonicalJson(request.unitIdDigests);
        if (!sameIntent) fail('CAUSAL_IMMUTABLE_CONFLICT', 'blockId already records different immutable assignment intent');
        const replayErrors = verifyCausalAssignmentBlockV2Internal(protocol, loaded.block, loaded.entropy);
        if (replayErrors.length > 0) fail('CAUSAL_INTEGRITY_FAILURE', replayErrors.join('; '));
        if (!previousManifest) fail('CAUSAL_INTEGRITY_FAILURE', 'retained assignment block has no authoritative manifest');
        db.prepare('COMMIT').run();
        return { status: 'existing', block: loaded.block, manifest: previousManifest };
      } finally {
        loaded.entropy.fill(0);
      }
    }

    const conflicts = db.prepare(
      'SELECT unit_id_digest FROM causal_assignment_units_v2 WHERE study_id = ? AND unit_id_digest IN (' +
      request.unitIdDigests.map(() => '?').join(',') + ') LIMIT 1',
    ).all(request.studyId, ...request.unitIdDigests) as Array<{ unit_id_digest: string }>;
    if (conflicts.length > 0) {
      fail('CAUSAL_UNIT_ALREADY_ASSIGNED', 'one or more unit digests are already assigned in this study');
    }
    const sequence = (previousManifest?.planCount ?? 0) + 1;
    const assignedCount = previousManifest?.unitCount ?? 0;
    if (protocol.stoppingRule.maxAssignments !== null
        && assignedCount + request.unitIdDigests.length > protocol.stoppingRule.maxAssignments) {
      fail('CAUSAL_STOPPING_RULE_REACHED', 'assignment would exceed the committed maximum enrollment');
    }

    entropy = Buffer.alloc(ENTROPY_BYTES);
    randomFillSync(entropy);
    if (entropy.byteLength !== ENTROPY_BYTES) fail('CAUSAL_RNG_FAILURE', 'cryptographic entropy source returned the wrong byte length');

    const block = deriveCausalAssignmentBlockV2Internal(protocol, {
      blockId: request.blockId,
      sequence,
      createdAtMs: request.createdAtMs,
      unitIdDigests: [...request.unitIdDigests],
      randomizationMaterial: entropy,
    });
    db.prepare(
      'INSERT INTO causal_assignment_plans_v2 ' +
      '(study_id, block_id, protocol_hash, sequence, created_at_ms, block_root, allocation_hash, material_digest, plan_hash, entropy_blob, plan_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      protocol.studyId,
      block.plan.blockId,
      protocol.protocolHash,
      sequence,
      block.plan.createdAtMs,
      block.plan.blockRoot,
      block.plan.allocationHash,
      block.plan.randomizationMaterialDigest,
      block.plan.planHash,
      entropy,
      canonicalJson(block.plan),
    );

    const insertDecision = db.prepare(
      'INSERT INTO causal_decisions_v2 ' +
      '(decision_id, study_id, block_id, block_sequence, decision_index, unit_id_digest, assigned_arm_id, event_hash, decision_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const decision of block.decisions) {
      insertDecision.run(
        decision.decisionId,
        decision.studyId,
        decision.blockId,
        decision.blockSequence,
        decision.decisionIndex,
        decision.unitIdDigest,
        decision.assignedArmId,
        decision.eventHash,
        canonicalJson(decision),
      );
    }

    const insertUnit = db.prepare(
      'INSERT INTO causal_assignment_units_v2 ' +
      '(study_id, unit_id_digest, decision_id, block_id, block_sequence, claimed_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const decision of block.decisions) {
      insertUnit.run(
        decision.studyId,
        decision.unitIdDigest,
        decision.decisionId,
        decision.blockId,
        decision.blockSequence,
        decision.assignedAtMs,
      );
    }

    const manifest = recomputeManifest(db, protocol);
    db.prepare(
      'INSERT INTO causal_assignment_manifests_v2 ' +
      '(study_id, generation, protocol_hash, manifest_hash, manifest_json) VALUES (?, ?, ?, ?, ?)',
    ).run(protocol.studyId, sequence, protocol.protocolHash, manifest.assignmentManifestHash, canonicalJson(manifest));
    const authoritativeManifest = currentManifest(db, protocol);
    db.prepare('COMMIT').run();
    return { status: 'created', block, manifest: authoritativeManifest };
  } catch (error) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // Preserve the original typed assignment failure if SQLite already ended it.
    }
    throw normalizedAssignmentError(error);
  } finally {
    entropy?.fill(0);
  }
}

function readCausalAssignmentManifestV2Store(
  db: DatabaseSync,
  studyId: string,
): CausalAssignmentManifestV2 | null {
  if (!safeId(studyId)) fail('CAUSAL_ASSIGNMENT_INVALID', 'studyId must be a safe namespaced identifier');
  db.prepare('BEGIN').run();
  try {
    const protocol = requireProtocolV2(db, studyId);
    const manifest = retainedManifest(db, protocol);
    db.prepare('COMMIT').run();
    return manifest;
  } catch (error) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // Preserve the integrity failure if SQLite already ended the transaction.
    }
    throw error;
  }
}

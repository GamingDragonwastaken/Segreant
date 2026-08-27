/**
 * Store-owned adapter for the independent causal-unit producer.
 *
 * The pure producer contract is intentionally useful in isolation, but a
 * product cannot call a caller-supplied snapshot "independent" unless the
 * snapshot has first crossed the Store's authenticated-row boundary.  This
 * adapter reads one exact v2 decision/execution/outcome, the request rows named
 * by that execution, the declared route scope, and the scalar realization/git
 * rows.  It derives the unit identity from retained commit metadata, verifies
 * the ordinary request ledger, and only then prepares a scalar lineage
 * binding.  It never reads or accepts prompts, source text, output, secrets,
 * or realization `unit_json`.
 *
 * The adapter is deliberately Store-internal.  A `ready` result is local,
 * reproducible evidence; it is not a provider invoice, an externally audited
 * causal effect, or permission to expose a public qualification result.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  decodeCausalExecutionV2,
  decodeCausalTerminalOutcomeV2,
} from '../causal/records.ts';
import {
  canonicalJson,
  isCausalIdentifier,
  isSha256,
  sha256,
  verifyCommittedCausalProtocol,
} from '../causal/protocol.ts';
import {
  independentCausalUnitIdDigestV2,
} from '../causal/identity.ts';
import {
  verifyCausalLedgerEvidence,
  type CausalLedgerEvidenceRowV2,
  type CausalLedgerVerificationResultV2,
} from '../causal/ledger.ts';
import type {
  CausalDecisionRecordV2,
  CausalExecutionRecordV2,
  CausalTerminalOutcomeRecordV2,
  CommittedCausalStudyProtocolV2,
} from '../causal/types.ts';
import {
  appendCausalLineageBindingV2WithinTransaction,
  causalLineageBindingDigestV2,
  causalRealizationSnapshotDigestV2,
  type CausalLineageBindingV2,
} from './causalLineage.ts';
import { causalV2SchemaComplete } from './schema.ts';

const COMMIT_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_SAFE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SUBJECT_CHARS = 4096;

const DECISION_KEYS = [
  'type', 'version', 'decisionId', 'studyId', 'blockId', 'protocolHash',
  'blockSequence', 'decisionIndex', 'unitIdDigest', 'assignedAtMs',
  'assignedArmId', 'propensity', 'blockRoot', 'planHash', 'allocationHash',
  'randomizationMaterialDigest', 'previousEventHash', 'eventHash',
] as const;

export type IndependentCausalProducerReasonCodeV2 =
  | 'causal_schema_unavailable'
  | 'input_invalid'
  | 'study_missing'
  | 'protocol_invalid'
  | 'decision_missing'
  | 'decision_invalid'
  | 'execution_missing'
  | 'execution_invalid'
  | 'outcome_missing'
  | 'outcome_invalid'
  | 'outcome_not_mature'
  | 'request_missing'
  | 'request_invalid'
  | 'request_ids_mismatch'
  | 'request_scope_unresolved'
  | 'request_provider_mismatch'
  | 'request_model_mismatch'
  | 'request_cost_invalid'
  | 'request_cost_sum_mismatch'
  | 'request_price_lineage_mismatch'
  | 'ordinary_ledger_unverified'
  | 'realization_missing'
  | 'realization_invalid'
  | 'realization_not_mature'
  | 'git_commit_missing'
  | 'git_commit_invalid'
  | 'identity_not_assigned'
  | 'identity_conflict'
  | 'binding_conflict';

export interface IndependentCausalProducerInputV2 {
  studyId: string;
  decisionId: string;
  executionId: string;
  outcomeId: string;
  realizationCommitHash: string;
  bindingId?: string;
  /** A caller may pin the check time, but it is never used as causal data. */
  checkedAtMs?: number;
}

export interface IndependentCausalProducerEvidenceV2 {
  algorithm: 'fiscus.causal.independent-unit';
  version: 2;
  identityMaterial: 'retained_git_commit_scalars';
  unitIdDigest: string;
  commitHash: string;
  project: string;
  realizationTsEpochMs: number;
  ledgerManifestHash: string;
  requestCount: number;
  limitation: string;
}

export interface IndependentCausalProducerAssessmentV2 {
  state: 'ready' | 'blocked';
  reasonCodes: IndependentCausalProducerReasonCodeV2[];
  binding: CausalLineageBindingV2 | null;
  unitIdDigest: string | null;
  ledger: CausalLedgerVerificationResultV2 | null;
  evidence: IndependentCausalProducerEvidenceV2 | null;
}

interface StoredProtocolRow { studyId: unknown; protocolHash: unknown; protocolJson: unknown }
interface StoredDecisionRow {
  decisionId: unknown;
  studyId: unknown;
  blockId: unknown;
  blockSequence: unknown;
  decisionIndex: unknown;
  unitIdDigest: unknown;
  assignedArmId: unknown;
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
  previousEventHash: unknown;
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
  previousEventHash: unknown;
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
  statusCode: unknown;
  costBasis: unknown;
  rateCardSha256: unknown;
  rateCardSourceKind: unknown;
  rateMatchKind: unknown;
  rateMatchProvider: unknown;
  rateMatchModel: unknown;
  scopeCaptureStatus: unknown;
  providerScopeDeclarationId: unknown;
}
interface StoredScopeRow {
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
  causalUnitIdDigest: unknown;
  attributedCostUsd: unknown;
  maturing: unknown;
  realized: unknown;
  costScope: unknown;
  costStale: unknown;
}
interface StoredGitRow {
  commitHash: unknown;
  project: unknown;
  tsEpochMs: unknown;
  linesAdded: unknown;
  linesDeleted: unknown;
  filesChanged: unknown;
  subject: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) && canonicalJson(value) === raw ? value : null;
  } catch {
    return null;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function safeText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function micros(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const result = Math.round(value * 1_000_000);
  return Number.isSafeInteger(result) ? result : null;
}

function commitSubjectDigest(subject: unknown): string | null {
  if (subject === null || subject === undefined) return null;
  if (typeof subject !== 'string' || subject.length > MAX_SUBJECT_CHARS || subject.includes('\0')) return null;
  return 'sha256:' + sha256('fiscus.causal.commit-subject\n1\n' + subject);
}

function decisionEventHash(value: Record<string, unknown>): string {
  const { eventHash: _ignored, ...material } = value;
  return 'sha256:' + sha256('fiscus.causal.decision\n2\n' + canonicalJson(material));
}

function parseDecision(row: StoredDecisionRow, input: IndependentCausalProducerInputV2): CausalDecisionRecordV2 | null {
  const value = canonicalRecord(row.decisionJson);
  if (!value || !exactRecord(value, DECISION_KEYS)
      || value.type !== 'fiscus.causal-decision' || value.version !== 2
      || !isCausalIdentifier(value.decisionId) || !isCausalIdentifier(value.studyId)
      || !isCausalIdentifier(value.blockId) || !isCausalIdentifier(value.assignedArmId)
      || !digest(value.protocolHash) || !digest(value.unitIdDigest)
      || !digest(value.blockRoot) || !digest(value.planHash) || !digest(value.allocationHash)
      || !digest(value.randomizationMaterialDigest) || !digest(value.previousEventHash)
      || !digest(value.eventHash) || !positiveInteger(value.blockSequence)
      || !positiveInteger(value.decisionIndex) || !positiveInteger(value.assignedAtMs)
      || value.propensity !== 0.5 || value.eventHash !== decisionEventHash(value)
      || row.decisionId !== value.decisionId || row.studyId !== value.studyId
      || row.blockId !== value.blockId || row.blockSequence !== value.blockSequence
      || row.decisionIndex !== value.decisionIndex || row.unitIdDigest !== value.unitIdDigest
      || row.assignedArmId !== value.assignedArmId || row.eventHash !== value.eventHash
      || value.studyId !== input.studyId || value.decisionId !== input.decisionId) {
    return null;
  }
  return value as unknown as CausalDecisionRecordV2;
}

function parseProtocol(row: StoredProtocolRow, studyId: string): CommittedCausalStudyProtocolV2 | null {
  const value = canonicalRecord(row.protocolJson);
  if (!value || value.version !== 2 || value.studyId !== studyId
      || row.studyId !== studyId || row.protocolHash !== value.protocolHash
      || verifyCommittedCausalProtocol(value).length > 0) return null;
  return value as unknown as CommittedCausalStudyProtocolV2;
}

function invalidAssessment(
  reasonCodes: IndependentCausalProducerReasonCodeV2[],
  ledger: CausalLedgerVerificationResultV2 | null = null,
  unitIdDigest: string | null = null,
): IndependentCausalProducerAssessmentV2 {
  return {
    state: 'blocked',
    reasonCodes: [...new Set(reasonCodes)],
    binding: null,
    unitIdDigest,
    ledger,
    evidence: null,
  };
}

function requestPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function rowsToLedgerEvidence(rows: StoredRequestRow[]): CausalLedgerEvidenceRowV2[] | null {
  const result: CausalLedgerEvidenceRowV2[] = [];
  for (const row of rows) {
    if (typeof row.requestId !== 'string' || !positiveInteger(row.tsEpochMs)
        || typeof row.provider !== 'string' || typeof row.model !== 'string'
        || typeof row.project !== 'string' || !finiteNumber(row.costUsd)
        || (row.estimated !== 0 && row.estimated !== 1)
        || (row.via !== 'proxy' && row.via !== 'import')
        || (row.statusCode !== null
          && (typeof row.statusCode !== 'number' || !Number.isInteger(row.statusCode)))) return null;
    result.push({
      requestId: row.requestId,
      tsEpochMs: row.tsEpochMs,
      provider: row.provider,
      model: row.model,
      project: row.project,
      costUsd: row.costUsd,
      estimated: row.estimated === 1,
      via: row.via,
      statusCode: row.statusCode,
      costBasis: typeof row.costBasis === 'string' ? row.costBasis : '',
      rateCardSha256: typeof row.rateCardSha256 === 'string' ? row.rateCardSha256 : null,
      rateCardSourceKind: typeof row.rateCardSourceKind === 'string' ? row.rateCardSourceKind : '',
      rateMatchKind: typeof row.rateMatchKind === 'string' ? row.rateMatchKind : '',
      rateMatchProvider: typeof row.rateMatchProvider === 'string' ? row.rateMatchProvider : null,
      rateMatchModel: typeof row.rateMatchModel === 'string' ? row.rateMatchModel : null,
      scopeCaptureStatus: typeof row.scopeCaptureStatus === 'string' ? row.scopeCaptureStatus : '',
      providerScopeDeclarationId: typeof row.providerScopeDeclarationId === 'string'
        ? row.providerScopeDeclarationId : null,
    });
  }
  return result;
}

/** Prepare one exact, independently-derived scalar binding without writing. */
export function prepareIndependentCausalLineageBindingV2(
  db: DatabaseSync,
  input: IndependentCausalProducerInputV2,
): IndependentCausalProducerAssessmentV2 {
  const reasons: IndependentCausalProducerReasonCodeV2[] = [];
  let inputShapeValid = false;
  try {
    inputShapeValid = isRecord(input)
      && isCausalIdentifier(input.studyId) && isCausalIdentifier(input.decisionId)
      && isCausalIdentifier(input.executionId) && isCausalIdentifier(input.outcomeId)
      && COMMIT_RE.test(input.realizationCommitHash)
      && (input.bindingId === undefined || isCausalIdentifier(input.bindingId))
      && (input.checkedAtMs === undefined || positiveInteger(input.checkedAtMs));
  } catch {
    return invalidAssessment(['input_invalid']);
  }
  if (!inputShapeValid) {
    return invalidAssessment(['input_invalid']);
  }
  try {
    if (!causalV2SchemaComplete(db)) return invalidAssessment(['causal_schema_unavailable']);

    const protocolRow = db.prepare(
      'SELECT study_id AS studyId, protocol_hash AS protocolHash, protocol_json AS protocolJson ' +
      'FROM causal_protocols WHERE study_id = ?',
    ).get(input.studyId) as StoredProtocolRow | undefined;
    if (!protocolRow) return invalidAssessment(['study_missing']);
    const protocol = parseProtocol(protocolRow, input.studyId);
    if (!protocol) return invalidAssessment(['protocol_invalid']);

    const decisionRow = db.prepare(
      'SELECT decision_id AS decisionId, study_id AS studyId, block_id AS blockId, ' +
      'block_sequence AS blockSequence, decision_index AS decisionIndex, unit_id_digest AS unitIdDigest, ' +
      'assigned_arm_id AS assignedArmId, event_hash AS eventHash, decision_json AS decisionJson ' +
      'FROM causal_decisions_v2 WHERE decision_id = ?',
    ).get(input.decisionId) as StoredDecisionRow | undefined;
    if (!decisionRow) return invalidAssessment(['decision_missing']);
    const decision = parseDecision(decisionRow, input);
    if (!decision) return invalidAssessment(['decision_invalid']);
    const arm = protocol.arms.find((candidate) => candidate.armId === decision.assignedArmId);
    if (!arm || arm.providerId === null || arm.modelId === null) return invalidAssessment(['decision_invalid']);

    const executionRow = db.prepare(
      'SELECT execution_id AS executionId, decision_id AS decisionId, study_id AS studyId, ' +
      'protocol_hash AS protocolHash, started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs, ' +
      'previous_event_hash AS previousEventHash, event_hash AS eventHash, execution_json AS executionJson ' +
      'FROM causal_executions_v2 WHERE execution_id = ?',
    ).get(input.executionId) as StoredExecutionRow | undefined;
    if (!executionRow) return invalidAssessment(['execution_missing']);
    let execution: CausalExecutionRecordV2;
    try {
      if (executionRow.executionId !== input.executionId || executionRow.decisionId !== decision.decisionId
          || executionRow.studyId !== protocol.studyId || executionRow.protocolHash !== protocol.protocolHash
          || typeof executionRow.executionJson !== 'string') throw new Error('execution physical identity');
      const decoded = decodeCausalExecutionV2(JSON.parse(executionRow.executionJson));
      if (canonicalJson(decoded) !== executionRow.executionJson
          || executionRow.startedAtMs !== decoded.startedAtMs
          || executionRow.completedAtMs !== decoded.completedAtMs
          || executionRow.previousEventHash !== decoded.previousEventHash
          || executionRow.eventHash !== decoded.eventHash
          || decoded.previousEventHash !== decision.eventHash
          || decoded.protocolHash !== protocol.protocolHash
          || decoded.assignedExecutionPlanDigest !== arm.executionPlanDigest
          || decoded.actualExecutionPlanDigest !== arm.executionPlanDigest
          || decoded.adherence !== 'confirmed') throw new Error('execution lineage');
      execution = decoded;
    } catch {
      return invalidAssessment(['execution_invalid']);
    }

    const outcomeRow = db.prepare(
      'SELECT outcome_id AS outcomeId, decision_id AS decisionId, study_id AS studyId, ' +
      'protocol_hash AS protocolHash, observed_at_ms AS observedAtMs, maturity, ' +
      'previous_event_hash AS previousEventHash, event_hash AS eventHash, terminal_outcome_json AS terminalOutcomeJson ' +
      'FROM causal_terminal_outcomes_v2 WHERE outcome_id = ?',
    ).get(input.outcomeId) as StoredOutcomeRow | undefined;
    if (!outcomeRow) return invalidAssessment(['outcome_missing']);
    let outcome: CausalTerminalOutcomeRecordV2;
    try {
      if (outcomeRow.outcomeId !== input.outcomeId || outcomeRow.decisionId !== decision.decisionId
          || outcomeRow.studyId !== protocol.studyId || outcomeRow.protocolHash !== protocol.protocolHash
          || typeof outcomeRow.terminalOutcomeJson !== 'string') throw new Error('outcome physical identity');
      const decoded = decodeCausalTerminalOutcomeV2(JSON.parse(outcomeRow.terminalOutcomeJson));
      if (canonicalJson(decoded) !== outcomeRow.terminalOutcomeJson
          || outcomeRow.observedAtMs !== decoded.observedAtMs
          || outcomeRow.maturity !== decoded.maturity
          || outcomeRow.previousEventHash !== decoded.previousEventHash
          || outcomeRow.eventHash !== decoded.eventHash
          || decoded.previousEventHash !== execution.eventHash
          || decoded.maturity !== 'matured'
          || decoded.qualityValue === null
          || decoded.qualityValue < protocol.qualityOutcome.bounds.low
          || decoded.qualityValue > protocol.qualityOutcome.bounds.high
          || decoded.qualityEvidenceClass !== protocol.qualityOutcome.evidenceClass
          || decoded.outcomeEvidenceDigests.length === 0) throw new Error('outcome lineage');
      outcome = decoded;
    } catch {
      return invalidAssessment(['outcome_invalid']);
    }

    if (execution.ordinaryLedgerVerifier.state !== 'verified') {
      reasons.push('ordinary_ledger_unverified');
    }
    if (execution.requestIds.length === 0) reasons.push('request_missing');
    const requestRows = execution.requestIds.length === 0 ? [] : db.prepare(
      'SELECT request_id AS requestId, ts_epoch_ms AS tsEpochMs, provider, model, project, cost_usd AS costUsd, ' +
      'estimated, via, status_code AS statusCode, cost_basis AS costBasis, rate_card_sha256 AS rateCardSha256, ' +
      'rate_card_source_kind AS rateCardSourceKind, rate_match_kind AS rateMatchKind, ' +
      'rate_match_provider AS rateMatchProvider, rate_match_model AS rateMatchModel, ' +
      'scope_capture_status AS scopeCaptureStatus, provider_scope_declaration_id AS providerScopeDeclarationId ' +
      `FROM requests WHERE request_id IN (${requestPlaceholders(execution.requestIds.length)}) ORDER BY request_id`,
    ).all(...execution.requestIds) as unknown as StoredRequestRow[];
    if (requestRows.length !== execution.requestIds.length) reasons.push('request_missing');
    const evidenceRows = rowsToLedgerEvidence(requestRows);
    if (!evidenceRows) reasons.push('request_invalid');
    if (evidenceRows && canonicalJson(evidenceRows.map((row) => row.requestId)) !== canonicalJson(execution.requestIds)) {
      reasons.push('request_ids_mismatch');
    }

    const declarationIds = new Set<string>();
    for (const row of requestRows) {
      if (typeof row.providerScopeDeclarationId !== 'string'
          || row.scopeCaptureStatus !== 'declared_unverified') {
        reasons.push('request_scope_unresolved');
        continue;
      }
      declarationIds.add(row.providerScopeDeclarationId);
      const scope = db.prepare(
        'SELECT declaration_id AS declarationId, provider, provider_project_ref AS providerProjectRef, trust ' +
        'FROM provider_scope_declarations WHERE declaration_id = ?',
      ).get(row.providerScopeDeclarationId) as StoredScopeRow | undefined;
      if (!scope || scope.declarationId !== row.providerScopeDeclarationId
          || scope.provider !== 'openai' || scope.providerProjectRef !== row.project
          || scope.trust !== 'operator_declared_unverified') {
        reasons.push('request_scope_unresolved');
      }
    }
    if (declarationIds.size !== 1) reasons.push('request_scope_unresolved');
    const declarationId = declarationIds.size === 1 ? [...declarationIds][0]! : null;

    const ledger = evidenceRows && declarationId
      ? verifyCausalLedgerEvidence({
        requests: evidenceRows,
        expected: {
          providerId: arm.providerId,
          modelId: arm.modelId,
          startedAtMs: execution.startedAtMs,
          completedAtMs: execution.completedAtMs,
          directCostUsd: execution.directAiCostUsd ?? Number.NaN,
          scopeDeclarationId: declarationId,
          priceLineageDigests: execution.priceLineageDigests,
        },
        checkedAtMs: input.checkedAtMs ?? Date.now(),
      })
      : null;
    if (!ledger || ledger.state !== 'verified') {
      reasons.push('ordinary_ledger_unverified');
    } else if (execution.ordinaryLedgerVerifier.state !== 'verified'
        || execution.ordinaryLedgerVerifier.requestCount !== ledger.requestCount
        || execution.ordinaryLedgerVerifier.evidenceManifestHash !== ledger.evidenceManifestHash) {
      reasons.push('ordinary_ledger_unverified');
    }

    const realization = db.prepare(
      'SELECT commit_hash AS commitHash, project, ts_epoch_ms AS tsEpochMs, computed_at_ms AS computedAtMs, ' +
      'causal_unit_id_digest AS causalUnitIdDigest, attributed_cost_usd AS attributedCostUsd, maturing, realized, ' +
      'cost_scope AS costScope, cost_stale AS costStale FROM realization_units WHERE commit_hash = ?',
    ).get(input.realizationCommitHash) as StoredRealizationRow | undefined;
    if (!realization) return invalidAssessment([...reasons, 'realization_missing'], ledger);
    if (realization.commitHash !== input.realizationCommitHash || !safeText(realization.project)
        || !positiveInteger(realization.tsEpochMs) || !positiveInteger(realization.computedAtMs)
        || !finiteNumber(realization.attributedCostUsd) || realization.attributedCostUsd < 0
        || (realization.maturing !== 0 && realization.maturing !== 1)
        || (realization.realized !== 0 && realization.realized !== 1)
        || (realization.costStale !== 0 && realization.costStale !== 1)
        || (realization.costScope !== 'project' && realization.costScope !== 'window')
        || realization.computedAtMs < realization.tsEpochMs
        || realization.tsEpochMs < execution.completedAtMs
        || realization.computedAtMs < execution.completedAtMs) {
      return invalidAssessment([...reasons, 'realization_invalid'], ledger);
    }
    if (realization.maturing !== 0 || realization.realized !== 1 || realization.costStale !== 0) {
      reasons.push('realization_not_mature');
    }

    const git = db.prepare(
      'SELECT commit_hash AS commitHash, project, ts_epoch_ms AS tsEpochMs, lines_added AS linesAdded, ' +
      'lines_deleted AS linesDeleted, files_changed AS filesChanged, subject FROM git_commits WHERE commit_hash = ?',
    ).get(input.realizationCommitHash) as StoredGitRow | undefined;
    if (!git) return invalidAssessment([...reasons, 'git_commit_missing'], ledger);
    if (git.commitHash !== input.realizationCommitHash || git.project !== realization.project
        || git.tsEpochMs !== realization.tsEpochMs || !nonNegativeInteger(git.linesAdded)
        || !nonNegativeInteger(git.linesDeleted) || !nonNegativeInteger(git.filesChanged)
        || (git.subject !== null && git.subject !== undefined && !safeText(git.subject, MAX_SUBJECT_CHARS))) {
      return invalidAssessment([...reasons, 'git_commit_invalid'], ledger);
    }
    if (requestRows.some((row) => row.project !== realization.project)) reasons.push('request_scope_unresolved');

    const unitIdDigest = independentCausalUnitIdDigestV2({
      studyId: protocol.studyId,
      commitHash: input.realizationCommitHash,
      project: realization.project,
      tsEpochMs: realization.tsEpochMs,
      linesAdded: git.linesAdded,
      linesDeleted: git.linesDeleted,
      filesChanged: git.filesChanged,
      subjectDigest: commitSubjectDigest(git.subject),
    });
    if (decision.unitIdDigest !== unitIdDigest) reasons.push('identity_not_assigned');
    if (realization.causalUnitIdDigest !== null && realization.causalUnitIdDigest !== undefined
        && realization.causalUnitIdDigest !== unitIdDigest) reasons.push('identity_conflict');

    const realizationSnapshotDigest = causalRealizationSnapshotDigestV2({
      commitHash: input.realizationCommitHash,
      project: realization.project,
      tsEpochMs: realization.tsEpochMs,
      computedAtMs: realization.computedAtMs,
      attributedCostUsd: realization.attributedCostUsd,
      maturing: realization.maturing === 1,
      realized: realization.realized === 1,
      costScope: realization.costScope,
      costStale: realization.costStale === 1,
    });
    const bindingMaterial = {
      type: 'fiscus.causal-lineage-binding' as const,
      version: 2 as const,
      bindingId: input.bindingId ?? `lineage:${input.studyId}:${input.decisionId}`,
      studyId: protocol.studyId,
      protocolHash: protocol.protocolHash,
      decisionId: decision.decisionId,
      executionId: execution.executionId,
      outcomeId: outcome.outcomeId,
      unitIdDigest,
      requestIds: [...execution.requestIds],
      realizationCommitHash: input.realizationCommitHash,
      realizationSnapshotDigest,
    };
    const binding: CausalLineageBindingV2 = {
      ...bindingMaterial,
      bindingDigest: causalLineageBindingDigestV2(bindingMaterial),
    };
    if (reasons.length > 0) return invalidAssessment(reasons, ledger, unitIdDigest);
    if (!ledger || ledger.evidenceManifestHash === null) return invalidAssessment(['ordinary_ledger_unverified'], ledger, unitIdDigest);
    const evidence: IndependentCausalProducerEvidenceV2 = {
      algorithm: 'fiscus.causal.independent-unit',
      version: 2,
      identityMaterial: 'retained_git_commit_scalars',
      unitIdDigest,
      commitHash: input.realizationCommitHash,
      project: realization.project,
      realizationTsEpochMs: realization.tsEpochMs,
      ledgerManifestHash: ledger.evidenceManifestHash,
      requestCount: ledger.requestCount,
      limitation: 'local reproducibility only; not provider invoice authority or a causal financial result',
    };
    return { state: 'ready', reasonCodes: [], binding, unitIdDigest, ledger, evidence };
  } catch {
    return invalidAssessment([...reasons, 'causal_schema_unavailable']);
  }
}

/**
 * Atomically mark the realization with the independently-derived identity and
 * append the scalar lineage binding.  The public lineage writer exposes a
 * transaction-scoped variant so this two-table operation cannot leave a
 * producer mark behind when binding validation or insertion fails.
 */
export function appendIndependentCausalLineageBindingV2(
  db: DatabaseSync,
  input: IndependentCausalProducerInputV2,
): IndependentCausalProducerAssessmentV2 {
  const prepared = prepareIndependentCausalLineageBindingV2(db, input);
  if (prepared.state !== 'ready' || prepared.binding === null) {
    throw new Error('CAUSAL_PRODUCER_BLOCKED: ' + prepared.reasonCodes.join(','));
  }
  let committed = false;
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    const existing = db.prepare(
      'SELECT causal_unit_id_digest AS digest FROM realization_units WHERE commit_hash = ?',
    ).get(input.realizationCommitHash) as { digest: unknown } | undefined;
    if (!existing) throw new Error('CAUSAL_PRODUCER_BLOCKED: realization_missing');
    if (existing.digest !== null && existing.digest !== undefined && existing.digest !== prepared.unitIdDigest) {
      throw new Error('CAUSAL_PRODUCER_BLOCKED: identity_conflict');
    }
    db.prepare(
      'UPDATE realization_units SET causal_unit_id_digest = ? WHERE commit_hash = ?',
    ).run(prepared.unitIdDigest, input.realizationCommitHash);
    appendCausalLineageBindingV2WithinTransaction(db, prepared.binding);
    db.prepare('COMMIT').run();
    committed = true;
    return { ...prepared, state: 'ready', reasonCodes: [], binding: prepared.binding };
  } catch (error) {
    if (!committed) {
      try { db.prepare('ROLLBACK').run(); } catch { /* no active transaction */ }
    }
    throw error;
  }
}

/** A convenience alias for callers that already know they only want a read. */
export const prepareCausalLineageBindingV2 = prepareIndependentCausalLineageBindingV2;

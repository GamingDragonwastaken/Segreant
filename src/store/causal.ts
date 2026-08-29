/**
 * SQLite persistence for local causal-study evidence.
 *
 * Rows are append-only after insertion. The store does not accept raw prompts
 * or source text as first-class evidence; the canonical types use identifiers,
 * hashes, and declared numerical outcomes only.
 */

import type { DatabaseSync } from 'node:sqlite';
import { verifyBlockedAssignmentPlan } from '../causal/assignment.ts';
import { estimateCausalStudy } from '../causal/estimate.ts';
import {
  canonicalJson,
  isCausalIdentifier,
  verifyCausalEvent,
  verifyCommittedCausalProtocol,
} from '../causal/protocol.ts';
import type {
  CausalAssignmentPlan,
  CausalExecutionRecord,
  CausalOutcomeRecord,
  CausalStudyData,
  CausalStudyEstimate,
  CommittedCausalStudyProtocol,
} from '../causal/types.ts';

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

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('stored causal ' + label + ' is malformed');
  }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const result = fn();
    db.prepare('COMMIT').run();
    return result;
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      // The failed statement can already have closed the transaction. Preserve
      // the original error, which carries the real causal-evidence defect.
    }
    throw err;
  }
}

function loadProtocol(db: DatabaseSync, studyId: string): CommittedCausalStudyProtocol | null {
  const row = db.prepare('SELECT protocol_json FROM causal_protocols WHERE study_id = ?')
    .get(studyId) as { protocol_json: string } | undefined;
  return row ? parseJson<CommittedCausalStudyProtocol>(row.protocol_json, 'protocol') : null;
}

function requireStoredProtocol(
  db: DatabaseSync,
  studyId: string,
  protocolHash: string,
): CommittedCausalStudyProtocol {
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
  protocol: CommittedCausalStudyProtocol,
): 'created' | 'existing' {
  const errors = verifyCommittedCausalProtocol(protocol);
  if (errors.length > 0) throw new Error('cannot register causal protocol: ' + errors.join('; '));
  const encoded = canonicalJson(protocol);
  const existing = db.prepare('SELECT protocol_hash, protocol_json FROM causal_protocols WHERE study_id = ?')
    .get(protocol.studyId) as { protocol_hash: string; protocol_json: string } | undefined;
  if (existing) {
    if (existing.protocol_hash === protocol.protocolHash && existing.protocol_json === encoded) return 'existing';
    throw new Error('studyId is already committed with different immutable protocol content');
  }
  db.prepare(
    'INSERT INTO causal_protocols (study_id, protocol_hash, committed_at_ms, protocol_json) VALUES (?, ?, ?, ?)',
  ).run(protocol.studyId, protocol.protocolHash, protocol.committedAtMs, encoded);
  return 'created';
}

export function saveCausalAssignmentPlan(
  db: DatabaseSync,
  plan: CausalAssignmentPlan,
): 'created' | 'existing' {
  const protocol = requireStoredProtocol(db, plan.studyId, plan.protocolHash);
  const errors = verifyBlockedAssignmentPlan(protocol, plan);
  if (errors.length > 0) throw new Error('cannot save causal assignment plan: ' + errors.join('; '));
  const encoded = canonicalJson(plan);
  const existing = db.prepare(
    'SELECT plan_json FROM causal_assignment_plans WHERE study_id = ? AND block_id = ?',
  ).get(plan.studyId, plan.blockId) as { plan_json: string } | undefined;
  if (existing) {
    if (existing.plan_json === encoded) return 'existing';
    throw new Error('causal assignment block is already recorded with different immutable content');
  }
  return transaction(db, () => {
    db.prepare(
      'INSERT INTO causal_assignment_plans (study_id, block_id, protocol_hash, created_at_ms, allocation_hash, material_sha256, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      plan.studyId,
      plan.blockId,
      plan.protocolHash,
      plan.createdAtMs,
      plan.allocationHash,
      plan.randomizationMaterialSha256,
      encoded,
    );
    const insert = db.prepare(
      'INSERT INTO causal_decisions (decision_id, study_id, protocol_hash, assigned_at_ms, event_hash, decision_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const decision of plan.decisions) {
      insert.run(
        decision.decisionId,
        decision.studyId,
        decision.protocolHash,
        decision.assignedAtMs,
        decision.eventHash,
        canonicalJson(decision),
      );
    }
    return 'created' as const;
  });
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
  requireStoredProtocol(db, record.studyId, record.protocolHash);
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

/** Append a resolved/pending outcome only when it follows a stored execution. */
export function appendCausalOutcome(db: DatabaseSync, record: CausalOutcomeRecord): 'created' | 'existing' {
  requireStoredProtocol(db, record.studyId, record.protocolHash);
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
    'SELECT p.study_id, p.protocol_hash, p.committed_at_ms, ' +
    '(SELECT COUNT(*) FROM causal_decisions d WHERE d.study_id = p.study_id) AS decisions, ' +
    '(SELECT COUNT(*) FROM causal_executions e WHERE e.study_id = p.study_id) AS executions, ' +
    '(SELECT COUNT(*) FROM causal_outcomes o WHERE o.study_id = p.study_id) AS outcomes, ' +
    '(SELECT analysis_id FROM causal_analysis_snapshots a WHERE a.study_id = p.study_id ORDER BY computed_at_ms DESC, analysis_id DESC LIMIT 1) AS analysis_id, ' +
    '(SELECT computed_at_ms FROM causal_analysis_snapshots a WHERE a.study_id = p.study_id ORDER BY computed_at_ms DESC, analysis_id DESC LIMIT 1) AS analysis_at, ' +
    '(SELECT state FROM causal_analysis_snapshots a WHERE a.study_id = p.study_id ORDER BY computed_at_ms DESC, analysis_id DESC LIMIT 1) AS analysis_state ' +
    'FROM causal_protocols p ORDER BY p.committed_at_ms DESC, p.study_id DESC',
  ).all() as Array<{
    study_id: string;
    protocol_hash: string;
    committed_at_ms: number;
    decisions: number;
    executions: number;
    outcomes: number;
    analysis_id: string | null;
    analysis_at: number | null;
    analysis_state: string | null;
  }>;
  return rows.map((row) => ({
    studyId: row.study_id,
    protocolHash: row.protocol_hash,
    committedAtMs: row.committed_at_ms,
    decisions: row.decisions,
    executions: row.executions,
    outcomes: row.outcomes,
    latestAnalysis: row.analysis_id && row.analysis_at !== null && row.analysis_state
      ? { analysisId: row.analysis_id, computedAtMs: row.analysis_at, state: row.analysis_state }
      : null,
  }));
}

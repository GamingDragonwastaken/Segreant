/** Store-owned append-only persistence for provenance-aware OPE observations. */

import { DatabaseSync } from 'node:sqlite';
import {
  canonicalJson,
  sha256,
} from '../causal/protocol.ts';
import {
  evaluateOpe,
  validateOpeInput,
  type OpeEvaluation,
  type OpeEvaluationOptions,
  type OpeObservation,
} from '../causal/ope.ts';

interface OpeObservationRow {
  observation_id: string;
  action_at_ms: number;
  outcome_at_ms: number;
  observation_digest: string;
  observation_json: string;
}

const OBSERVATION_DIGEST_DOMAIN = 'fiscus.ope.observation';
const STRUCTURAL_BOUNDS = { low: -Number.MAX_SAFE_INTEGER, high: Number.MAX_SAFE_INTEGER } as const;
const STRUCTURAL_OVERLAP = { minLoggingPropensity: Number.MIN_VALUE, maxImportanceWeight: Number.MAX_SAFE_INTEGER } as const;

function structuralInput(observation: OpeObservation) {
  return {
    estimator: 'ips' as const,
    observations: [observation],
    rewardBounds: STRUCTURAL_BOUNDS,
    overlap: STRUCTURAL_OVERLAP,
    policyConstraints: {
      policy: { ...observation.targetPolicy },
      mode: 'fixed' as const,
      explorationRate: 0,
      budgetUnitsPerObservationMax: Number.MAX_SAFE_INTEGER,
      maxImportanceWeight: Number.MAX_SAFE_INTEGER,
      maxTailContribution: Number.MAX_SAFE_INTEGER,
    },
  };
}

function observationDigest(observation: OpeObservation): string {
  return sha256(`${OBSERVATION_DIGEST_DOMAIN}\n1\n${canonicalJson(observation)}`);
}

function decodeRow(row: OpeObservationRow): OpeObservation {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.observation_json);
  } catch {
    throw new Error('OPE observation JSON is malformed');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('OPE observation JSON is not an object');
  }
  const observation = decoded as OpeObservation;
  if (observation.observationId !== row.observation_id
      || observation.actionAtMs !== row.action_at_ms
      || observation.outcomeAtMs !== row.outcome_at_ms
      || observationDigest(observation) !== row.observation_digest) {
    throw new Error('OPE observation digest or retained identity is invalid');
  }
  validateOpeInput(structuralInput(observation));
  return observation;
}

export function recordOpeObservation(db: DatabaseSync, observation: OpeObservation): 'created' | 'existing' {
  validateOpeInput(structuralInput(observation));
  const encoded = canonicalJson(observation);
  const digest = observationDigest(observation);
  const existing = db.prepare(
    'SELECT observation_id, action_at_ms, outcome_at_ms, observation_digest, observation_json FROM ope_action_observations WHERE observation_id = ?',
  ).get(observation.observationId) as OpeObservationRow | undefined;
  if (existing) {
    if (existing.observation_digest === digest && existing.observation_json === encoded) return 'existing';
    throw new Error('OPE observationId is already recorded with different immutable content');
  }
  db.prepare(
    'INSERT INTO ope_action_observations (observation_id, action_at_ms, outcome_at_ms, observation_digest, observation_json) VALUES (?, ?, ?, ?, ?)',
  ).run(observation.observationId, observation.actionAtMs, observation.outcomeAtMs, digest, encoded);
  return 'created';
}

export function opeObservations(db: DatabaseSync): OpeObservation[] {
  const rows = db.prepare(
    'SELECT observation_id, action_at_ms, outcome_at_ms, observation_digest, observation_json FROM ope_action_observations ORDER BY action_at_ms, observation_id',
  ).all() as unknown as OpeObservationRow[];
  return rows.map(decodeRow);
}

export function evaluatePersistedOpe(db: DatabaseSync, options: OpeEvaluationOptions): OpeEvaluation {
  return evaluateOpe({ ...options, observations: opeObservations(db) });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import type { OpeEvaluationOptions, OpeObservation } from '../src/causal/ope.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function row(id: string, reward: number): OpeObservation {
  return {
    observationId: id,
    unitId: `unit-${id}`,
    actionId: 'model-a',
    treatmentId: 'treatment-model-a',
    reward,
    actionAtMs: 1_000,
    outcomeAtMs: 2_000,
    context: { schemaId: 'context-v1', digest: A, observedAtMs: 900 },
    loggingPolicy: { policyId: 'logging', version: '1', digest: A, propensity: 0.5 },
    targetPolicy: { policyId: 'target', version: '1', digest: B, probability: 0.5 },
  };
}

const options: OpeEvaluationOptions = {
  estimator: 'ips',
  rewardBounds: { low: 0, high: 1 },
  overlap: { minLoggingPropensity: 0.05, maxImportanceWeight: 20 },
};

test('Store-owned OPE observations are append-only, idempotent, and replayable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-ope-'));
  const dbPath = join(dir, 'fiscus.db');
  try {
    const first = new Store(dbPath);
    assert.equal(first.recordOpeObservation(row('obs-1', 0.8)), 'created');
    assert.equal(first.recordOpeObservation(row('obs-1', 0.8)), 'existing');
    assert.equal(first.recordOpeObservation(row('obs-2', 0.2)), 'created');
    assert.equal(first.evaluateOpe(options).estimate, 0.5);
    first.close();

    const reopened = new Store(dbPath);
    assert.equal(reopened.opeObservations().length, 2);
    assert.equal(reopened.evaluateOpe(options).estimate, 0.5);
    assert.throws(() => reopened.recordOpeObservation(row('obs-1', 0.9)), /immutable|different/i);
    assert.throws(() => reopened.raw().prepare('UPDATE ope_action_observations SET observation_json = ? WHERE observation_id = ?').run('{}', 'obs-1'), /append-only/i);
    assert.throws(() => reopened.raw().prepare('DELETE FROM ope_action_observations WHERE observation_id = ?').run('obs-1'), /append-only/i);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Store OPE replay fails closed when the retained observation digest is tampered', () => {
  const store = new Store(':memory:');
  store.recordOpeObservation(row('obs-1', 0.8));
  store.raw().prepare('DROP TRIGGER causal_no_update_ope_action_observations').run();
  store.raw().prepare("UPDATE ope_action_observations SET observation_json = '{\"observationId\":\"obs-1\"}' WHERE observation_id = 'obs-1'").run();
  assert.throws(() => store.opeObservations(), /digest|integrity|OPE/i);
  store.close();
});

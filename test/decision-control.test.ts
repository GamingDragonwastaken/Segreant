import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyControlTransition,
  commitControlTransition,
  createControlPolicy,
  previewControlTransition,
  rollbackControl,
  startControlLifecycle,
  type ControlObservation,
  type ControlPolicy,
  type PolicyLifecycle,
} from '../src/decision/control.ts';

const issuedAt = '2026-09-05T00:00:00.000Z';
const regime = {
  treatment: 'policy-v1',
  model: 'model-a@1',
  pricing: 'card-2026-09',
  environment: 'test',
} as const;

function makePolicy(overrides: Partial<Parameters<typeof createControlPolicy>[0]> = {}): ControlPolicy {
  return createControlPolicy({
    id: 'policy:test',
    version: 1,
    issuedAt,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    requiredEvidenceIds: ['quality', 'cost'],
    regime,
    fallback: 'baseline',
    ...overrides,
  });
}

function makeObservation(at: string, overrides: Partial<ControlObservation> = {}): ControlObservation {
  return {
    at,
    completeness: 'complete',
    regime,
    evidence: [
      { id: 'quality', state: 'supported', observable: true, revoked: false, completeness: 'complete', observedAt: issuedAt, freshUntil: '2026-09-10T00:00:00.000Z' },
      { id: 'cost', state: 'supported', observable: true, revoked: false, completeness: 'complete', observedAt: issuedAt, freshUntil: '2026-09-10T00:00:00.000Z' },
    ],
    measurement: { status: 'healthy', observable: true, observedAt: issuedAt, freshUntil: '2026-09-10T00:00:00.000Z' },
    outcome: { status: 'safe', observable: true, observedAt: issuedAt, freshUntil: '2026-09-10T00:00:00.000Z' },
    ...overrides,
  };
}

function lifecycle(policy = makePolicy()): PolicyLifecycle {
  return startControlLifecycle(policy, issuedAt);
}

test('control lifecycle advances only through the declared rollout phases', () => {
  let state = lifecycle();
  state = applyControlTransition(state, { to: 'simulated_effect', at: '2026-09-05T01:00:00.000Z', observation: makeObservation('2026-09-05T01:00:00.000Z') });
  state = applyControlTransition(state, { to: 'canary', at: '2026-09-05T02:00:00.000Z', observation: makeObservation('2026-09-05T02:00:00.000Z') });
  state = applyControlTransition(state, { to: 'monitored_expansion', at: '2026-09-05T03:00:00.000Z', observation: makeObservation('2026-09-05T03:00:00.000Z') });
  state = applyControlTransition(state, { to: 'full_rollout', at: '2026-09-05T04:00:00.000Z', observation: makeObservation('2026-09-05T04:00:00.000Z') });
  assert.equal(state.phase, 'full_rollout');
  assert.deepEqual(state.history.map((event) => `${event.from}->${event.to}`), [
    'shadow->simulated_effect',
    'simulated_effect->canary',
    'canary->monitored_expansion',
    'monitored_expansion->full_rollout',
  ]);
});

test('unsafe phase jumps are rejected and cannot be committed', () => {
  const state = lifecycle();
  const proposal = previewControlTransition(state, {
    to: 'full_rollout',
    at: '2026-09-05T01:00:00.000Z',
    observation: makeObservation('2026-09-05T01:00:00.000Z'),
  });
  assert.equal(proposal.status, 'rejected');
  assert.equal(proposal.persistable, false);
  assert.equal(proposal.nextState, null);
  assert.ok(proposal.reasons.includes('unsafe_transition'));
  assert.throws(() => commitControlTransition(state, proposal), /cannot commit|rejected/i);
  assert.equal(state.history.length, 0);
});

test('stale evidence and expired policy TTL fail closed to the declared fallback', () => {
  const state = applyControlTransition(lifecycle(), {
    to: 'simulated_effect',
    at: '2026-09-05T01:00:00.000Z',
    observation: makeObservation('2026-09-05T01:00:00.000Z'),
  });
  const staleAt = '2026-09-10T00:00:00.000Z';
  const stale = previewControlTransition(state, {
    to: 'canary',
    at: staleAt,
    observation: makeObservation(staleAt),
  });
  assert.equal(stale.status, 'fallback');
  assert.equal(stale.persistable, true);
  assert.ok(stale.reasons.includes('evidence_stale'));
  assert.equal(stale.nextState?.phase, 'rolled_back');

  const expired = previewControlTransition(lifecycle(), {
    to: 'simulated_effect',
    at: '2026-09-12T00:00:00.000Z',
    observation: makeObservation('2026-09-12T00:00:00.000Z'),
  });
  assert.equal(expired.status, 'fallback');
  assert.deepEqual(expired.reasons, ['policy_ttl_expired']);
  assert.equal(expired.nextState?.fallback, 'baseline');
});

test('unknown, unobservable, revoked, and harmful observations never advance a rollout', () => {
  const state = applyControlTransition(lifecycle(), {
    to: 'simulated_effect',
    at: '2026-09-05T01:00:00.000Z',
    observation: makeObservation('2026-09-05T01:00:00.000Z'),
  });
  const at = '2026-09-05T02:00:00.000Z';
  const unknownOutcome = { ...makeObservation(at).outcome, status: 'unknown' as const };
  const proposal = previewControlTransition(state, {
    to: 'canary',
    at,
    observation: makeObservation(at, { outcome: unknownOutcome }),
  });
  assert.equal(proposal.status, 'fallback');
  assert.ok(proposal.reasons.includes('unobservable'));
  assert.equal(proposal.nextState?.phase, 'rolled_back');

  const revoked = previewControlTransition(state, {
    to: 'canary',
    at,
    observation: makeObservation(at, { evidence: makeObservation(at).evidence.map((item) => item.id === 'quality' ? { ...item, revoked: true } : item) }),
  });
  assert.equal(revoked.status, 'fallback');
  assert.ok(revoked.reasons.includes('evidence_revoked'));
});

test('rollback is monotonic and stale proposals cannot commit against a new revision', () => {
  const state = applyControlTransition(lifecycle(), {
    to: 'simulated_effect',
    at: '2026-09-05T01:00:00.000Z',
    observation: makeObservation('2026-09-05T01:00:00.000Z'),
  });
  const proposal = previewControlTransition(state, {
    to: 'canary',
    at: '2026-09-05T02:00:00.000Z',
    observation: makeObservation('2026-09-05T02:00:00.000Z'),
  });
  const rolledBack = rollbackControl(state, '2026-09-05T01:30:00.000Z', 'manual_rollback');
  assert.equal(rolledBack.phase, 'rolled_back');
  assert.equal(rollbackControl(rolledBack, '2026-09-05T02:30:00.000Z', 'manual_rollback'), rolledBack);
  assert.throws(() => commitControlTransition(rolledBack, proposal), /revision|stale|current/i);
  assert.throws(() => previewControlTransition(rolledBack, {
    to: 'canary',
    at: '2026-09-05T03:00:00.000Z',
    observation: makeObservation('2026-09-05T03:00:00.000Z'),
  }), /already_rolled_back|rolled_back/i);
});

test('policy construction rejects unsafe TTLs and empty identifiers', () => {
  for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => makePolicy({ ttlMs }), /TTL|ttl|positive|finite|representable/i);
  }
  assert.throws(() => makePolicy({ id: ' ' }), /id|non-empty/i);
});

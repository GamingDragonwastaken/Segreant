import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { certifyDecision } from '../src/decision/engine.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { buildDecisionKernelIssuance, issueDecisionToKernel } from '../src/decision/epistemic.ts';
import type { Evidence } from '../src/epistemic/evidence.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const issuedAt = '2026-09-03T12:00:00.000Z';
const intervals = [
  { action: 'keep', low: 12, high: 18 },
  { action: 'route', low: 2, high: 10 },
] as const;

function sourceEvidence(id = 'evidence:decision:source'): Evidence {
  const time = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' };
  return {
    id, evidenceType: 'decision.utility.input', sourceIdentity: 'test', sourceClass: 'test', payload: { id },
    scope: scope({ ledger: 'test', decision: 'decision-1' }), grain: grain(['decision']),
    occurredAt: time.from, validTime: time, observedAt: issuedAt, recordedAt: issuedAt, assertedAt: issuedAt, finalizedAt: null,
    integrity: 'verified', authenticity: 'self_asserted', completeness: { status: 'complete', method: 'test', coveredEventTypes: [], coveredScope: null, coveredTime: null },
    measurementModelRef: null, monetaryBasis: null, assumptions: [], supersedes: [], supersededBy: null, revocation: null,
    schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
  };
}

function ledger(): EpistemicLedger { return new EpistemicLedger(new DatabaseSync(':memory:')); }

test('decision adapter issues an observation, fitness claim, witness, and derivation atomically', () => {
  const result = issueDecisionToKernel(ledger(), {
    decisionId: 'decision-1', certificate: certifyDecision(intervals), intervals,
    evidence: [{ id: 'evidence:decision:source', record: sourceEvidence() }], issuedAt,
  });
  assert.equal(result.observation.proposition.predicate, 'decision.utility_interval_observed');
  assert.equal(result.decision?.profile.decisionFitness, 'sufficient');
  assert.equal(result.witness?.kind, 'decision_fitness');
  assert.ok(result.derivation);
  assert.equal(result.derivation?.inputClaimIds.length, 1);
});

test('undetermined certificates issue only the observation and never a decision derivation', () => {
  const result = buildDecisionKernelIssuance({
    decisionId: 'decision-1', certificate: certifyDecision([{ action: 'a', low: 1, high: 9 }, { action: 'b', low: 4, high: 10 }]),
    intervals: [{ action: 'a', low: 1, high: 9 }, { action: 'b', low: 4, high: 10 }],
    evidence: [{ id: 'evidence:decision:source', record: sourceEvidence() }], issuedAt,
  });
  assert.equal(result.decision, null);
  assert.equal(result.derivation, null);
  assert.equal(result.witness, null);
});

test('adapter rejects certificate/action mismatches and missing evidence bindings', () => {
  assert.throws(() => buildDecisionKernelIssuance({
    decisionId: 'decision-1', certificate: certifyDecision(intervals), intervals: [{ action: 'other', low: 12, high: 18 }, { action: 'route', low: 2, high: 10 }],
    evidence: [{ id: 'evidence:decision:source', record: sourceEvidence() }], issuedAt,
  }), /does not match/i);
  assert.throws(() => buildDecisionKernelIssuance({
    decisionId: 'decision-1', certificate: certifyDecision(intervals), intervals, evidence: [], issuedAt,
  }), /evidence binding/i);
});

test('replay is exact and revoking source evidence revokes all downstream decision records', () => {
  const store = ledger();
  const input = { decisionId: 'decision-1', certificate: certifyDecision(intervals), intervals, evidence: [{ id: 'evidence:decision:source', record: sourceEvidence() }], issuedAt } as const;
  const first = issueDecisionToKernel(store, input);
  const replay = issueDecisionToKernel(store, input);
  assert.deepEqual(replay, first);
  store.appendRevocation({ eventId: 'revoke:source-1', targetId: 'evidence:decision:source', recordedAt: issuedAt, reason: 'source withdrawn' });
  const revoked = store.revocationProjection().revokedIds;
  assert.ok(revoked.includes(first.observation.id));
  assert.ok(first.decision && revoked.includes(first.decision.id));
});

test('record bindings must agree with their explicit IDs', () => {
  assert.throws(() => buildDecisionKernelIssuance({
    decisionId: 'decision-1', certificate: certifyDecision(intervals), intervals,
    evidence: [{ id: 'wrong-id', record: sourceEvidence() }], issuedAt,
  }), /does not match/i);
});

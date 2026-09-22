import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim } from '../src/epistemic/claim.ts';
import { derivation } from '../src/epistemic/derivation.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { witness } from '../src/epistemic/witness.ts';

const baseEvidence = evidence({
  id: 'evidence:replay:base', evidenceType: 'provider.statement', sourceIdentity: 'provider:test', sourceClass: 'provider_statement',
  payload: { amount: '10.00', currency: 'USD' }, scope: scope({ account: 'acct-replay' }), grain: grain(['day']),
  occurredAt: '2026-08-01T00:00:00.000Z', observedAt: '2026-08-01T12:00:00.000Z', integrity: 'verified', authenticity: 'provider_authenticated',
  completeness: { status: 'complete', method: 'fixture' }, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
});

const laterEvidence = evidence({
  id: 'evidence:replay:later', evidenceType: 'provider.correction', sourceIdentity: 'provider:test', sourceClass: 'provider_statement',
  payload: { amount: '11.00', currency: 'USD' }, scope: scope({ account: 'acct-replay' }), grain: grain(['day']),
  occurredAt: '2026-08-03T00:00:00.000Z', observedAt: '2026-08-04T12:00:00.000Z', integrity: 'verified', authenticity: 'provider_authenticated',
  completeness: { status: 'complete', method: 'fixture' }, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
});

function claimFor(id: string, issuedAt: string, evidenceIds: readonly string[]) {
  return claim({
    id, proposition: { predicate: 'cost.observed', value: { amount: '10.00' } }, subject: 'project:replay',
    scope: scope({ account: 'acct-replay' }), grain: grain(['day']), time: { asOf: issuedAt }, epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'provider_authenticated', scope: 'established', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'provider_observed', finality: 'provisional', decisionFitness: 'not_assessed' }),
    measurementModelRef: null, evidenceIds, derivationRule: 'replay.fixture.v1', derivationVersion: 1, causalStatus: 'none', issuedAt, schemaVersion: 1,
  });
}

function fixtureLedger(): { db: DatabaseSync; ledger: EpistemicLedger } {
  const db = new DatabaseSync(':memory:');
  const ledger = new EpistemicLedger(db);
  ledger.appendEvidence(baseEvidence);
  ledger.appendEvidence(laterEvidence);
  const baseClaim = claimFor('claim:replay:base', '2026-08-02T12:00:00.000Z', [baseEvidence.id]);
  const laterClaim = claimFor('claim:replay:later', '2026-08-06T12:00:00.000Z', [baseEvidence.id]);
  ledger.appendClaim(baseClaim);
  ledger.appendClaim(laterClaim);
  const proof = witness({
    id: 'witness:replay:later', kind: 'epistemic_resolution', evidenceIds: [laterEvidence.id], detail: 'Later provider correction witness',
    issuedAt: '2026-08-05T12:00:00.000Z', epistemic: 'supported', schemaVersion: 1,
  });
  ledger.appendWitness(proof);
  ledger.appendDerivation(derivation({
    id: 'derivation:replay:later', inputEvidenceIds: [baseEvidence.id], inputClaimIds: [baseClaim.id], transformation: 'replay fixture identity',
    outputClaimId: laterClaim.id, outputProposition: laterClaim.proposition,
    coordinateChange: { from: { grain: baseClaim.grain, scope: baseClaim.scope }, to: { grain: laterClaim.grain, scope: laterClaim.scope } },
    witnesses: [{ id: proof.id, kind: proof.kind, evidenceIds: proof.evidenceIds, detail: proof.detail }], version: 1, reproducibilityHash: 'sha256:replay-fixture',
  }));
  ledger.appendRevocation({ eventId: 'event:replay:base', targetId: baseEvidence.id, recordedAt: '2026-08-07T12:00:00.000Z', reason: 'base statement corrected' });
  ledger.appendRevocation({ eventId: 'event:replay:later', targetId: laterEvidence.id, recordedAt: '2026-08-09T12:00:00.000Z', reason: 'correction withdrawn' });
  return { db, ledger };
}

test('replay conformance vectors prevent availability and revocation hindsight leakage', () => {
  const { db, ledger } = fixtureLedger();
  const vectors = [
    {
      asOf: '2026-08-01T11:59:59.999Z', nodes: [], revoked: [],
    },
    {
      asOf: '2026-08-03T00:00:00.000Z', nodes: ['claim:replay:base', 'evidence:replay:base'], revoked: [],
    },
    {
      asOf: '2026-08-06T12:00:00.000Z', nodes: ['claim:replay:base', 'evidence:replay:base', 'evidence:replay:later', 'witness:replay:later', 'claim:replay:later'], revoked: [],
    },
    {
      asOf: '2026-08-08T00:00:00.000Z', nodes: ['claim:replay:base', 'evidence:replay:base', 'evidence:replay:later', 'witness:replay:later', 'claim:replay:later'], revoked: ['claim:replay:base', 'claim:replay:later', 'evidence:replay:base'],
    },
    {
      asOf: '2026-08-10T00:00:00.000Z', nodes: ['claim:replay:base', 'evidence:replay:base', 'evidence:replay:later', 'witness:replay:later', 'claim:replay:later'], revoked: ['claim:replay:base', 'claim:replay:later', 'evidence:replay:base', 'evidence:replay:later', 'witness:replay:later'],
    },
  ] as const;
  for (const vector of vectors) {
    const replay = ledger.replayAsOf(vector.asOf);
    assert.equal(replay.asOf, vector.asOf);
    assert.deepEqual(replay.graph.nodes.map((node) => node.id), [...vector.nodes].sort());
    assert.deepEqual(replay.revocation.revokedIds, [...vector.revoked].sort());
    assert.ok(Object.isFrozen(replay));
  }
  db.close();
});

test('replay conformance is deterministic across repeated reads and handles', () => {
  const { db, ledger } = fixtureLedger();
  const first = ledger.replayAsOf('2026-08-08T00:00:00.000Z');
  const second = ledger.replayAsOf('2026-08-08T00:00:00.000Z');
  const reopened = new EpistemicLedger(db).replayAsOf('2026-08-08T00:00:00.000Z');
  assert.deepEqual(second, first);
  assert.deepEqual(reopened, first);
  db.close();
});

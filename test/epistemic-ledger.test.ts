import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { assumption } from '../src/epistemic/assumption.ts';
import { derivation, type DerivationInput } from '../src/epistemic/derivation.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

function evidenceInput(id = 'evidence:invoice'): EvidenceInput {
  return {
    id,
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34', currency: 'USD' },
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    occurredAt: '2026-08-01T00:00:00.000Z',
    observedAt: '2026-08-02T00:00:00.000Z',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    completeness: { status: 'complete', method: 'provider_export' },
    monetaryBasis: 'billed',
    schemaVersion: 1,
    sensitivity: 'confidential',
    redaction: 'none',
  };
}

function claimInput(id: string, evidenceId: string): ClaimInput {
  return {
    id,
    proposition: { predicate: 'cost.reconciled', value: { amount: '12.34' } },
    subject: 'project:api',
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day', 'project']),
    time: { validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'), asOf: '2026-08-02T00:00:01.000Z' },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported', integrity: 'verified', authenticity: 'provider_authenticated',
      scope: 'established', coverage: 'complete', measurement: 'proxy_unvalidated',
      causality: 'none', monetaryBasis: 'billed', finality: 'provisional', decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [evidenceId],
    derivationRule: 'billing.reconcile.v1',
    derivationVersion: 1,
    causalStatus: 'none',
    issuedAt: '2026-08-02T00:00:01.000Z',
    schemaVersion: 1,
  };
}

function derivationInput(sourceId: string, outputId: string): DerivationInput {
  return {
    id: 'derivation:reconcile:1',
    inputEvidenceIds: ['evidence:invoice'],
    inputClaimIds: [sourceId],
    transformation: 'reconcile identical provider rows',
    outputClaimId: outputId,
    outputProposition: { predicate: 'cost.reconciled', value: { amount: '12.34' } },
    coordinateChange: {
      from: { grain: grain(['day', 'project']), scope: scope({ account: 'acct-1' }) },
      to: { grain: grain(['day', 'project']), scope: scope({ account: 'acct-1' }) },
    },
    witnesses: [],
    version: 1,
    reproducibilityHash: 'sha256:derivation-1',
  };
}

function ledger(): { db: DatabaseSync; value: EpistemicLedger } {
  const db = new DatabaseSync(':memory:');
  return { db, value: new EpistemicLedger(db) };
}

test('ledger persists canonical Evidence, Claim, Derivation, and dependency edges across handles', () => {
  const { db, value } = ledger();
  const e = evidence(evidenceInput());
  const source = claim(claimInput('claim:source', e.id));
  const output = claim(claimInput('claim:output', e.id));
  const d = derivation(derivationInput(source.id, output.id));

  assert.equal(value.appendEvidence(e), 'inserted');
  assert.equal(value.appendClaim(source), 'inserted');
  assert.equal(value.appendClaim(output), 'inserted');
  assert.equal(value.appendDerivation(d), 'inserted');
  assert.equal(value.appendDerivation(d), 'duplicate');

  const reopened = new EpistemicLedger(db);
  assert.deepEqual(reopened.readEvidence(e.id), e);
  assert.deepEqual(reopened.readClaim(source.id), source);
  assert.deepEqual(reopened.readDerivation(d.id), d);
  assert.deepEqual(reopened.graph().edges, [
    { from: 'claim:source', to: 'claim:output', relation: 'derives' },
    { from: 'evidence:invoice', to: 'claim:output', relation: 'depends_on' },
    { from: 'evidence:invoice', to: 'claim:output', relation: 'supports' },
    { from: 'evidence:invoice', to: 'claim:source', relation: 'supports' },
  ]);
  db.close();
});

test('ledger exact replays are idempotent but divergent same-ID records are refused', () => {
  const { db, value } = ledger();
  const e = evidence(evidenceInput());
  assert.equal(value.appendEvidence(e), 'inserted');
  assert.equal(value.appendEvidence(e), 'duplicate');
  assert.throws(() => value.appendEvidence(evidence({ ...e, payload: { amount: '99.00', currency: 'USD' } })), /different evidence/);
  assert.throws(() => value.appendRevocation({ eventId: 'event:1', targetId: 'missing', recordedAt: '2026-08-03T00:00:00.000Z', reason: 'correction' }), /unknown target/);
  db.close();
});

test('ledger dependency writes are atomic and append-only triggers reject update/delete', () => {
  const { db, value } = ledger();
  const missingClaim = claim(claimInput('claim:missing-evidence', 'evidence:missing'));
  assert.throws(() => value.appendClaim(missingClaim), /unknown evidence/);
  assert.equal(value.readClaim(missingClaim.id), null);

  const e = evidence(evidenceInput());
  value.appendEvidence(e);
  const source = claim(claimInput('claim:source', e.id));
  const output = claim(claimInput('claim:output', e.id));
  value.appendClaim(source);
  value.appendClaim(output);
  value.appendDerivation(derivation(derivationInput(source.id, output.id)));

  assert.throws(() => db.prepare("UPDATE epistemic_claims SET claim_json = '{}' WHERE claim_id = ?").run(source.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM epistemic_edges WHERE from_id = ?").run(e.id), /append-only/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO epistemic_claims (claim_id, claim_json, claim_digest) VALUES (?, '{}', 'tampered')").run(source.id), /append-only/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO epistemic_edges (from_id, to_id, relation) VALUES (?, ?, ?)").run(e.id, source.id, 'supports'), /append-only/);
  db.close();
});

test('ledger revocation events project transitively, preserve siblings, and support as-of replay', () => {
  const { db, value } = ledger();
  const e = evidence(evidenceInput());
  const source = claim(claimInput('claim:source', e.id));
  const output = claim(claimInput('claim:output', e.id));
  value.appendEvidence(e);
  value.appendClaim(source);
  value.appendClaim(output);
  value.appendDerivation(derivation(derivationInput(source.id, output.id)));
  assert.equal(value.appendRevocation({ eventId: 'event:invoice-revoked', targetId: e.id, recordedAt: '2026-08-05T00:00:00.000Z', reason: 'provider correction' }), 'inserted');
  assert.equal(value.appendRevocation({ eventId: 'event:invoice-revoked', targetId: e.id, recordedAt: '2026-08-05T00:00:00.000Z', reason: 'provider correction' }), 'duplicate');
  const projection = value.revocationProjection();
  assert.deepEqual(projection.revokedIds, ['claim:output', 'claim:source', 'evidence:invoice']);
  assert.equal(value.asOf('2026-08-01T12:00:00.000Z').nodes.length, 0);
  assert.deepEqual(value.asOf('2026-08-03T00:00:00.000Z').nodes.map((node) => node.id), ['claim:output', 'claim:source', 'evidence:invoice']);
  db.close();
});

test('ledger persists first-class assumptions and links them to Claims for revocation', () => {
  const { db, value } = ledger();
  const e = evidence(evidenceInput());
  value.appendEvidence(e);
  const a = assumption({
    id: 'assumption:coverage',
    statement: 'The source covers the declared period.',
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day']),
    asOf: '2026-08-02T00:00:00.000Z',
    epistemic: 'supported',
    evidenceIds: [e.id],
    issuedAt: '2026-08-02T00:00:00.000Z',
    schemaVersion: 1,
  });
  assert.equal(value.appendAssumption(a), 'inserted');
  const c = claim({ ...claimInput('claim:source', e.id), assumptionIds: [a.id] });
  assert.equal(value.appendClaim(c), 'inserted');
  assert.deepEqual(value.readAssumption(a.id), a);
  assert.deepEqual(value.graph().edges, [
    { from: 'assumption:coverage', to: 'claim:source', relation: 'assumes' },
    { from: 'evidence:invoice', to: 'assumption:coverage', relation: 'supports' },
    { from: 'evidence:invoice', to: 'claim:source', relation: 'supports' },
  ]);
  assert.equal(value.appendRevocation({ eventId: 'event:assumption-revoked', targetId: a.id, recordedAt: '2026-08-03T00:00:00.000Z', reason: 'coverage invalidated' }), 'inserted');
  assert.deepEqual(value.revocationProjection().revokedIds, ['assumption:coverage', 'claim:source']);
  db.close();
});

test('ledger rejects graph cycles and unknown dependency endpoints before mutation', () => {
  const { db, value } = ledger();
  value.appendNode({ id: 'a', kind: 'decision', availableAt: '2026-08-01T00:00:00.000Z' });
  value.appendNode({ id: 'b', kind: 'decision', availableAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(value.appendDependency({ from: 'a', to: 'b', relation: 'derives' }), 'inserted');
  assert.throws(() => value.appendDependency({ from: 'b', to: 'a', relation: 'derives' }), /cycle/);
  assert.throws(() => value.appendDependency({ from: 'a', to: 'missing', relation: 'supports' }), /unknown node/);
  assert.deepEqual(value.graph().edges, [{ from: 'a', to: 'b', relation: 'derives' }]);
  assert.throws(() => value.appendNode({ id: 'unmaterialized-claim', kind: 'claim', availableAt: '2026-08-01T00:00:00.000Z' }), /appendClaim/);
  db.close();
});

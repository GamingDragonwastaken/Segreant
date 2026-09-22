import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const eInput: EvidenceInput = {
  id: 'evidence:store:1',
  evidenceType: 'local.test',
  sourceIdentity: 'test:store',
  sourceClass: 'local_observation',
  payload: { observed: true },
  scope: scope({ project: 'atlas' }),
  grain: grain(['request']),
  observedAt: '2026-08-01T00:00:00.000Z',
  integrity: 'verified',
  authenticity: 'self_asserted',
  completeness: { status: 'partial', method: 'test-fixture' },
  schemaVersion: 1,
  sensitivity: 'internal',
  redaction: 'none',
};

function cInput(evidenceId: string): ClaimInput {
  return {
    id: 'claim:store:1',
    proposition: { predicate: 'request.observed', value: { observed: true } },
    subject: 'request:1',
    scope: scope({ project: 'atlas' }),
    grain: grain(['request']),
    time: { asOf: '2026-08-01T00:00:01.000Z' },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted',
      scope: 'conditional', coverage: 'partial', measurement: 'proxy_unvalidated',
      causality: 'none', monetaryBasis: 'none', finality: 'unknown', decisionFitness: 'not_assessed',
    }),
    measurementModelRef: null,
    evidenceIds: [evidenceId],
    derivationRule: 'test.identity.v1',
    derivationVersion: 1,
    causalStatus: 'none',
    issuedAt: '2026-08-01T00:00:01.000Z',
    schemaVersion: 1,
  };
}

test('Store exposes the kernel ledger on the same SQLite handle without changing operational tables', () => {
  const store = new Store(':memory:');
  try {
    const e = evidence(eInput);
    const c = claim(cInput(e.id));
    assert.equal(store.epistemic().appendEvidence(e), 'inserted');
    assert.equal(store.epistemic().appendClaim(c), 'inserted');
    assert.deepEqual(store.epistemic().readEvidence(e.id), e);
    assert.deepEqual(store.epistemic().readClaim(c.id), c);
    assert.deepEqual(store.epistemic().graph().edges, [{ from: e.id, to: c.id, relation: 'supports' }]);
    assert.equal(store.summary(0, Date.parse('2026-08-02T00:00:00.000Z')).requests, 0);
  } finally {
    store.close();
  }
});

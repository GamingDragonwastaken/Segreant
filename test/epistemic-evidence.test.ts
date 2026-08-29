import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

function baseEvidence(): EvidenceInput {
  return {
    id: 'evidence:invoice:1',
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: {
      amount: '12.34',
      currency: 'USD',
      rows: [{ project: 'api', amount: '12.34' }],
    },
    scope: scope({ account: 'acct-1', provider: 'openai' }),
    grain: grain(['day', 'project']),
    occurredAt: '2026-08-01T00:00:00.000Z',
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
    observedAt: '2026-08-02T03:00:00.000Z',
    recordedAt: '2026-08-02T03:00:01.000Z',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    completeness: { status: 'complete', method: 'provider_export' },
    measurementModelRef: 'measurement:provider-cost:v1',
    monetaryBasis: 'billed',
    assumptions: ['provider export is authoritative for the declared account'],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'confidential',
    redaction: 'none',
  };
}

test('canonical Evidence preserves typed coordinates and separates trust dimensions', () => {
  const input = baseEvidence();
  const item = evidence(input);

  assert.equal(item.id, 'evidence:invoice:1');
  assert.deepEqual(item.scope.constraints.map((constraint) => constraint.key), ['account', 'provider']);
  assert.deepEqual(item.grain.dimensions, ['day', 'project']);
  assert.equal(item.integrity, 'verified');
  assert.equal(item.authenticity, 'provider_authenticated');
  assert.equal(item.completeness.status, 'complete');
  assert.equal(item.monetaryBasis, 'billed');
  assert.equal(item.schemaVersion, 1);
  assert.equal(Object.hasOwn(item, 'trusted'), false);
  assert.equal(Object.hasOwn(item, 'established'), false);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.payload), true);
  assert.equal(Object.isFrozen(item.completeness), true);
  assert.deepEqual(item.payload, input.payload);
});

test('Evidence clones and freezes nested payloads and assumptions', () => {
  const input = baseEvidence();
  const item = evidence(input);

  (input.payload as { amount: string }).amount = '99.99';
  assert.equal((item.payload as { amount: string }).amount, '12.34');
  assert.throws(() => {
    (item.payload as { amount: string }).amount = '99.99';
  }, TypeError);
  assert.throws(() => {
    (item.assumptions as string[]).push('new assumption');
  }, TypeError);
});

test('hash-only and reference-only evidence are valid without retaining raw payload', () => {
  const hashOnly = { ...baseEvidence(), payload: undefined, payloadHash: 'sha256:invoice-1' };
  const referenceOnly = { ...baseEvidence(), payload: undefined, reference: 'vault://invoice/1' };

  assert.equal(evidence(hashOnly).payload, undefined);
  assert.equal(evidence(hashOnly).payloadHash, 'sha256:invoice-1');
  assert.equal(evidence(referenceOnly).reference, 'vault://invoice/1');
});

test('Evidence rejects missing provenance, coordinates, acquisition time, and payload source', () => {
  const base = baseEvidence();
  assert.throws(() => evidence({ ...base, id: '' }), /non-empty/);
  assert.throws(() => evidence({ ...base, sourceIdentity: '  ' }), /non-empty/);
  assert.throws(() => evidence({ ...base, scope: undefined as never }), /scope/);
  assert.throws(() => evidence({ ...base, grain: undefined as never }), /grain/);
  assert.throws(() => evidence({ ...base, observedAt: undefined, recordedAt: undefined, assertedAt: undefined }), /acquisition timestamp/);
  assert.throws(() => evidence({ ...base, payload: undefined, payloadHash: undefined, reference: undefined }), /payload, payloadHash, or reference/);
});

test('Evidence rejects invalid trust/completeness values, noncanonical times, and unknown fields', () => {
  const base = baseEvidence();
  assert.throws(() => evidence({ ...base, integrity: 'trusted' as never }), /integrity/);
  assert.throws(() => evidence({ ...base, authenticity: 'trusted' as never }), /authenticity/);
  assert.throws(() => evidence({ ...base, completeness: { status: 'complete-ish' } as never }), /completeness/);
  assert.throws(() => evidence({ ...base, observedAt: '2026-08-02T03:00:00Z' }), /canonical UTC ISO-8601/);
  assert.throws(() => evidence({ ...base, trusted: true } as EvidenceInput & { trusted: boolean }), /unknown field/);
});

test('Evidence rejects non-JSON payload values and invalid version/classification metadata', () => {
  const base = baseEvidence();
  assert.throws(() => evidence({ ...base, payload: { amount: Number.NaN } }), /finite/);
  assert.throws(() => evidence({ ...base, payload: { callback: () => true } as never }), /JSON-compatible/);
  assert.throws(() => evidence({ ...base, schemaVersion: 0 }), /schemaVersion/);
  assert.throws(() => evidence({ ...base, sensitivity: 'top-secret' as never }), /sensitivity/);
  assert.throws(() => evidence({ ...base, redaction: 'unknown' as never }), /redaction/);
});

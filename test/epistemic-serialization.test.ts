import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim } from '../src/epistemic/claim.ts';
import { evidence } from '../src/epistemic/evidence.ts';
import { assumption } from '../src/epistemic/assumption.ts';
import { derivation } from '../src/epistemic/derivation.ts';
import { witness } from '../src/epistemic/witness.ts';
import {
  canonicalJson,
  deserializeClaim,
  deserializeEvidence,
  serializeAssumption,
  serializeClaim,
  serializeDerivation,
  serializeEvidence,
  deserializeWitness,
  serializeWitness,
  type SerializedEpistemicRecord,
} from '../src/epistemic/serialization.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

const e = evidence({
  id: 'evidence:serialization', evidenceType: 'test', sourceIdentity: 'test:source', sourceClass: 'fixture',
  payload: { z: 1, a: { second: true, first: 'x' } }, scope: scope({ project: 'atlas' }), grain: grain(['request']),
  observedAt: '2026-08-01T00:00:00.000Z', integrity: 'verified', authenticity: 'self_asserted',
  completeness: { status: 'partial' }, schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
});

const c = claim({
  id: 'claim:serialization', proposition: { predicate: 'request.observed', value: { b: 2, a: 1 } }, subject: 'request:1',
  scope: scope({ project: 'atlas' }), grain: grain(['request']), time: { asOf: '2026-08-01T00:00:01.000Z' },
  epistemic: 'supported', profile: claimProfile({
    epistemic: 'supported', integrity: 'verified', authenticity: 'self_asserted', scope: 'conditional', coverage: 'partial',
    measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'unknown', decisionFitness: 'not_assessed',
  }), evidenceIds: [e.id], derivationRule: 'test.v1', derivationVersion: 1, causalStatus: 'none',
  issuedAt: '2026-08-01T00:00:01.000Z', schemaVersion: 1,
});

test('canonical JSON sorts object keys and emits reproducible record digests', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 1 } }), '{"a":{"c":1,"d":2},"z":1}');
  const first = serializeEvidence(e);
  const second = serializeEvidence(evidence({ ...e, payload: { a: { first: 'x', second: true }, z: 1 } }));
  assert.deepEqual(second, first);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.kind, 'evidence');
  assert.equal(first.schemaVersion, 1);
});

test('all canonical kernel records round-trip through verified envelopes', () => {
  const a = assumption({
    id: 'assumption:serialization', statement: 'fixture is complete', scope: scope({ project: 'atlas' }), grain: grain(['request']),
    asOf: '2026-08-01T00:00:00.000Z', epistemic: 'supported', evidenceIds: [e.id], issuedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 1,
  });
  const d = derivation({
    id: 'derivation:serialization', inputEvidenceIds: [e.id], inputClaimIds: [c.id], transformation: 'identity', outputClaimId: c.id,
    outputProposition: c.proposition, coordinateChange: { from: { grain: c.grain, scope: c.scope }, to: { grain: c.grain, scope: c.scope } },
    version: 1, reproducibilityHash: 'sha256:derivation',
  });
  const w = witness({
    id: 'witness:serialization', kind: 'epistemic_resolution', evidenceIds: [e.id],
    detail: 'fixture witness', issuedAt: '2026-08-01T00:00:02.000Z', epistemic: 'supported', schemaVersion: 1,
  });
  const records: SerializedEpistemicRecord[] = [serializeEvidence(e), serializeClaim(c), serializeAssumption(a), serializeWitness(w), serializeDerivation(d)];
  assert.equal(deserializeEvidence(records[0]!).id, e.id);
  assert.equal(deserializeClaim(records[1]!).id, c.id);
  assert.equal(records[2]!.kind, 'assumption');
  assert.equal(deserializeWitness(records[3]!).id, w.id);
  assert.equal(records[4]!.kind, 'derivation');
});

test('deserialization fails closed on tampered bytes, digest, kind, version, and unsupported values', () => {
  const record = serializeEvidence(e);
  assert.throws(() => deserializeEvidence({ ...record, body: record.body.replace('serialization', 'tampered') }), /digest/);
  assert.throws(() => deserializeEvidence({ ...record, digest: 'sha256:' + '0'.repeat(64) }), /digest/);
  assert.throws(() => deserializeEvidence({ ...record, kind: 'claim' as never }), /kind/);
  assert.throws(() => deserializeEvidence({ ...record, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycle/);
});

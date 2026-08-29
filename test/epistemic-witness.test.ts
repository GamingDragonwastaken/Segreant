import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { witness, type WitnessInput } from '../src/epistemic/witness.ts';

const from = { grain: grain(['day', 'provider']), scope: scope({ account: 'acct-1' }) };
const to = { grain: grain(['day', 'provider', 'model']), scope: scope({ account: 'acct-1' }) };

function input(overrides: Partial<WitnessInput> = {}): WitnessInput {
  return {
    id: 'witness:refinement:1',
    kind: 'grain_refinement',
    from,
    to,
    evidenceIds: ['evidence:usage-export'],
    detail: 'The provider export contains a stable model dimension.',
    issuedAt: '2026-08-02T00:00:00.000Z',
    epistemic: 'supported',
    schemaVersion: 1,
    ...overrides,
  };
}

test('canonical witness is immutable, evidence-grounded, and preserves exact coordinates', () => {
  const value = witness(input());
  assert.equal(value.id, 'witness:refinement:1');
  assert.equal(value.kind, 'grain_refinement');
  assert.deepEqual(value.evidenceIds, ['evidence:usage-export']);
  assert.equal(value.detail, 'The provider export contains a stable model dimension.');
  assert.equal(value.issuedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(value.epistemic, 'supported');
  assert.equal(value.schemaVersion, 1);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.from), true);
  assert.equal(Object.isFrozen(value.to), true);
  assert.equal(Object.isFrozen(value.evidenceIds), true);
});

test('witness validation fails closed on malformed, ungrounded, or semantically mismatched records', () => {
  assert.throws(() => witness(input({ evidenceIds: [] })), /at least one evidence/);
  assert.throws(() => witness(input({ from: undefined })), /requires from and to/);
  assert.throws(() => witness(input({ kind: 'epistemic_resolution', from, to })), /cannot carry coordinates/);
  assert.throws(() => witness({ ...input(), trusted: true } as never), /unknown field: trusted/);
  assert.throws(() => witness(input({ issuedAt: '2026-08-02T00:00:00Z' })), /canonical UTC/);
  assert.throws(() => witness(input({ schemaVersion: 0 })), /schemaVersion/);
});

test('non-coordinate witnesses carry no coordinate laundering payload', () => {
  const value = witness(input({
    id: 'witness:resolution:1',
    kind: 'epistemic_resolution',
    from: undefined,
    to: undefined,
  }));
  assert.equal(value.from, undefined);
  assert.equal(value.to, undefined);
});

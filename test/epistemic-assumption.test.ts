import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumption, type AssumptionInput } from '../src/epistemic/assumption.ts';
import { grain } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

function base(): AssumptionInput {
  return {
    id: 'assumption:provider-completeness',
    statement: 'The provider export covers every billed project in the declared period.',
    scope: scope({ account: 'acct-1', provider: 'openai' }),
    grain: grain(['project', 'day']),
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
    asOf: '2026-08-02T03:00:00.000Z',
    epistemic: 'supported',
    evidenceIds: ['evidence:invoice:1'],
    issuedAt: '2026-08-02T03:00:00.000Z',
    supersedes: [],
    supersededBy: null,
    schemaVersion: 1,
  };
}

test('canonical Assumption is immutable, scoped, time-qualified, and evidence-linked', () => {
  const item = assumption(base());
  assert.equal(item.id, 'assumption:provider-completeness');
  assert.equal(item.epistemic, 'supported');
  assert.deepEqual(item.grain.dimensions, ['day', 'project']);
  assert.deepEqual(item.scope.constraints.map((constraint) => constraint.key), ['account', 'provider']);
  assert.deepEqual(item.evidenceIds, ['evidence:invoice:1']);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.evidenceIds), true);
  assert.equal(Object.hasOwn(item, 'trusted'), false);
});

test('Assumption normalizes optional lifecycle arrays and rejects malformed or unknown fields', () => {
  assert.deepEqual(assumption({ ...base(), evidenceIds: [' evidence:invoice:1 '] }).evidenceIds, ['evidence:invoice:1']);
  assert.throws(() => assumption({ ...base(), statement: ' ' }), /non-empty/);
  assert.throws(() => assumption({ ...base(), evidenceIds: ['evidence:1', 'evidence:1'] }), /duplicate/);
  assert.throws(() => assumption({ ...base(), epistemic: 'trusted' as never }), /epistemic/);
  assert.throws(() => assumption({ ...base(), issuedAt: '2026-08-02T03:00:00Z' }), /canonical UTC ISO-8601/);
  assert.throws(() => assumption({ ...base(), unknown: true } as AssumptionInput & { unknown: boolean }), /unknown field/);
  assert.throws(() => assumption({ ...base(), schemaVersion: 0 }), /schemaVersion/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  revocationClosure,
  type DependencyEdge,
} from '../src/epistemic/revocation.ts';

const graph: DependencyEdge[] = [
  { from: 'evidence:invoice', to: 'claim:billed-cost' },
  { from: 'claim:billed-cost', to: 'claim:allocated-cost' },
  { from: 'claim:allocated-cost', to: 'decision:budget' },
  { from: 'evidence:experiment', to: 'claim:causal-value' },
  { from: 'claim:causal-value', to: 'decision:budget' },
];

test('revocation propagates transitively through every dependent claim and decision', () => {
  assert.deepEqual(
    revocationClosure(['evidence:invoice'], graph),
    ['claim:allocated-cost', 'claim:billed-cost', 'decision:budget', 'evidence:invoice'].sort(),
  );
});

test('independent evidence branches are not revoked merely because they share a downstream decision', () => {
  const revoked = revocationClosure(['evidence:invoice'], graph);
  assert.equal(revoked.includes('evidence:experiment'), false);
  assert.equal(revoked.includes('claim:causal-value'), false);
  assert.equal(revoked.includes('decision:budget'), true);
});

test('revocation closure handles cycles safely and rejects malformed/duplicate edges', () => {
  const cyclic: DependencyEdge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
  ];
  assert.deepEqual(revocationClosure(['a'], cyclic), ['a', 'b']);
  assert.throws(() => revocationClosure(['a'], [{ from: '', to: 'b' }]), /non-empty/);
  assert.throws(() => revocationClosure(['a'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]), /duplicate dependency edge/);
});

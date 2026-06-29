import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSourceDepth } from '../src/value/sourceDepth.ts';

test('describeSourceDepth: untagged "direct" traffic is spend-only', () => {
  assert.deepEqual(
    describeSourceDepth({ tagged: false, hasProposals: false, hasOutcomes: false }),
    { depth: 'untagged · spend only', full: false },
  );
});

test('describeSourceDepth: a tagged source with no further signal is just spend', () => {
  assert.deepEqual(
    describeSourceDepth({ tagged: true, hasProposals: false, hasOutcomes: false }),
    { depth: 'spend', full: false },
  );
});

test('describeSourceDepth: captured proposals add the acceptance signal', () => {
  assert.deepEqual(
    describeSourceDepth({ tagged: true, hasProposals: true, hasOutcomes: false }),
    { depth: 'spend + acceptance', full: false },
  );
});

test('describeSourceDepth: realized projects add the RoI/outcomes signal', () => {
  assert.deepEqual(
    describeSourceDepth({ tagged: true, hasProposals: false, hasOutcomes: true }),
    { depth: 'spend + RoI', full: false },
  );
});

test('describeSourceDepth: both signals present = the full value loop', () => {
  assert.deepEqual(
    describeSourceDepth({ tagged: true, hasProposals: true, hasOutcomes: true }),
    { depth: 'spend + acceptance + RoI', full: true },
  );
});

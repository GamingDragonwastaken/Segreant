import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOutcomeContract,
  outcomeBounds,
  type OutcomeContract,
  type OutcomeEvaluation,
} from '../src/outcomes/contract.ts';
import type { EpistemicState } from '../src/epistemic/state.ts';

const contract: OutcomeContract = {
  id: 'software-shipped-clean',
  requiredPredicates: ['tested', 'merged', 'shipped', 'survived', 'clean'],
};

function evaluate(states: Partial<Record<string, EpistemicState>>): OutcomeEvaluation {
  return evaluateOutcomeContract(contract, (predicate) => states[predicate] ?? 'unknown');
}

test('an outcome is confirmed only when every required predicate is supported', () => {
  assert.equal(evaluate({
    tested: 'supported',
    merged: 'supported',
    shipped: 'supported',
    survived: 'supported',
    clean: 'supported',
  }).status, 'confirmed');

  const missingShipped = evaluate({
    tested: 'supported',
    merged: 'supported',
    survived: 'supported',
    clean: 'supported',
  });
  assert.equal(missingShipped.status, 'unresolved');
  assert.deepEqual(missingShipped.unresolvedPredicates, ['shipped']);
});

test('a required refutation fails the outcome but a conflict remains visibly conflicted', () => {
  const failed = evaluate({
    tested: 'supported', merged: 'supported', shipped: 'refuted', survived: 'supported', clean: 'supported',
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.refutedPredicates, ['shipped']);

  const conflicted = evaluate({
    tested: 'supported', merged: 'supported', shipped: 'conflicted', survived: 'supported', clean: 'supported',
  });
  assert.equal(conflicted.status, 'conflicted');
  assert.deepEqual(conflicted.conflictedPredicates, ['shipped']);
});

test('failure takes precedence over unresolved, while conflict is preserved alongside failure evidence', () => {
  const result = evaluate({ tested: 'refuted', shipped: 'conflicted' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.refutedPredicates, ['tested']);
  assert.deepEqual(result.conflictedPredicates, ['shipped']);
  assert.ok(result.unresolvedPredicates.includes('merged'));
});

test('outcome bounds are genuine partial-identification bounds over terminal status', () => {
  const evaluations: OutcomeEvaluation[] = [
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'supported', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'unknown', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'conflicted', survived: 'supported', clean: 'supported' }),
    evaluate({ tested: 'supported', merged: 'supported', shipped: 'refuted', survived: 'supported', clean: 'supported' }),
  ];

  const bounds = outcomeBounds(evaluations);
  assert.deepEqual(bounds, {
    lower: 0.25,
    upper: 0.75,
    n: 4,
    confirmed: 1,
    failed: 1,
    unresolved: 1,
    conflicted: 1,
  });
});

test('contracts reject empty or duplicate required predicates', () => {
  assert.throws(
    () => evaluateOutcomeContract({ id: 'empty', requiredPredicates: [] }, () => 'unknown'),
    /at least one required predicate/,
  );
  assert.throws(
    () => evaluateOutcomeContract({ id: 'dup', requiredPredicates: ['shipped', 'shipped'] }, () => 'supported'),
    /duplicate required predicate/,
  );
});

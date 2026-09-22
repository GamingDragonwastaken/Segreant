import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPISTEMIC_STATES,
  aggregateEvidence,
  informationJoin,
  informationLeq,
  stateFromPolarity,
  statePolarity,
  type EpistemicState,
} from '../src/epistemic/state.ts';

const states: readonly EpistemicState[] = EPISTEMIC_STATES;

test('epistemic state preserves ignorance, support, refutation, and conflict as four distinct states', () => {
  assert.equal(stateFromPolarity({ support: false, refute: false }), 'unknown');
  assert.equal(stateFromPolarity({ support: true, refute: false }), 'supported');
  assert.equal(stateFromPolarity({ support: false, refute: true }), 'refuted');
  assert.equal(stateFromPolarity({ support: true, refute: true }), 'conflicted');

  for (const state of states) {
    assert.equal(stateFromPolarity(statePolarity(state)), state);
  }
});

test('information join accumulates evidence instead of letting the last verdict overwrite prior evidence', () => {
  assert.equal(informationJoin('unknown', 'supported'), 'supported');
  assert.equal(informationJoin('supported', 'refuted'), 'conflicted');
  assert.equal(informationJoin('refuted', 'supported'), 'conflicted');
  assert.equal(informationJoin('conflicted', 'unknown'), 'conflicted');
});

test('information join is a commutative idempotent associative semilattice', () => {
  for (const a of states) {
    assert.equal(informationJoin(a, a), a, `idempotence failed for ${a}`);
    for (const b of states) {
      assert.equal(informationJoin(a, b), informationJoin(b, a), `commutativity failed for ${a}, ${b}`);
      for (const c of states) {
        assert.equal(
          informationJoin(informationJoin(a, b), c),
          informationJoin(a, informationJoin(b, c)),
          `associativity failed for ${a}, ${b}, ${c}`,
        );
      }
    }
  }
});

test('information order makes unknown least, conflicted most-informed, and support/refutation incomparable', () => {
  assert.equal(informationLeq('unknown', 'supported'), true);
  assert.equal(informationLeq('unknown', 'refuted'), true);
  assert.equal(informationLeq('supported', 'conflicted'), true);
  assert.equal(informationLeq('refuted', 'conflicted'), true);
  assert.equal(informationLeq('supported', 'refuted'), false);
  assert.equal(informationLeq('refuted', 'supported'), false);
  assert.equal(informationLeq('conflicted', 'supported'), false);
});

test('aggregateEvidence is order-independent and conflict-preserving', () => {
  const evidence = [
    { support: true, refute: false },
    { support: false, refute: false },
    { support: false, refute: true },
  ] as const;

  assert.equal(aggregateEvidence(evidence), 'conflicted');
  assert.equal(aggregateEvidence([...evidence].reverse()), 'conflicted');
  assert.equal(aggregateEvidence([]), 'unknown');
});

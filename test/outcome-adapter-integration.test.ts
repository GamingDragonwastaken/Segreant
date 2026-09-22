import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptOutcome, createWorkUnit } from '../src/outcomes/work-unit.ts';
import { classifySession, NON_CODING_OUTCOME_ADAPTER } from '../src/value/usage.ts';

test('non-coding usage exposes canonical OutcomeAdapter evidence', () => {
  const unit = createWorkUnit({
    id: 'session-adapter-1',
    kind: 'non_coding_session',
    startedAtMs: 100,
    endedAtMs: 200,
    context: { signals: [{ kind: 'used', verdict: 'pass' }] },
  });

  const adapted = adaptOutcome(unit, NON_CODING_OUTCOME_ADAPTER);

  assert.equal(adapted.adapterId, 'non-coding-reported-outcome-v1');
  assert.equal(adapted.evaluation.status, 'confirmed');
  assert.deepEqual(adapted.evaluation.supportedPredicates, ['reported_outcome']);
  assert.equal(adapted.evidence.provenance, 'adapter:non-coding-reported-outcome-v1');
  assert.equal(adapted.evidence.coverage, 'complete');
});

test('the canonical non-coding adapter preserves conflict instead of flattening it', () => {
  const unit = createWorkUnit({
    id: 'session-adapter-conflict',
    kind: 'non_coding_session',
    startedAtMs: 100,
    endedAtMs: 200,
    context: {
      signals: [
        { kind: 'used', verdict: 'pass' },
        { kind: 'incident', verdict: 'fail' },
      ],
    },
  });

  const adapted = adaptOutcome(unit, NON_CODING_OUTCOME_ADAPTER);

  assert.equal(adapted.evaluation.status, 'conflicted');
  assert.deepEqual(adapted.evaluation.conflictedPredicates, ['reported_outcome']);
  assert.equal(classifySession([
    { kind: 'used', verdict: 'pass' },
    { kind: 'incident', verdict: 'fail' },
  ]).state, 'conflicted');
});

test('coding realization exposes a versioned OutcomeAdapter without flattening unknown or conflict', async () => {
  const { CODING_OUTCOME_ADAPTER, evaluateCodingOutcome } = await import('../src/value/gates.ts');
  const unit = createWorkUnit({
    id: 'commit-adapter-1',
    kind: 'coding_commit',
    startedAtMs: 100,
    endedAtMs: 200,
    context: {
      gateStates: {
        proposed: 'supported',
        accepted: 'supported',
        committed: 'supported',
        tested: 'supported',
        merged: 'supported',
        shipped: 'supported',
        survived: 'supported',
        clean: 'supported',
      },
    },
  });

  assert.equal(CODING_OUTCOME_ADAPTER.id, 'coding-gate-lifecycle-v1');
  assert.equal(adaptOutcome(unit, CODING_OUTCOME_ADAPTER).evaluation.status, 'confirmed');
  assert.equal(evaluateCodingOutcome({
    proposed: { gate: 'proposed', polarity: 'supported', verdict: 'pass', detail: '' },
    accepted: { gate: 'accepted', polarity: 'supported', verdict: 'pass', detail: '' },
    committed: { gate: 'committed', polarity: 'supported', verdict: 'pass', detail: '' },
    tested: { gate: 'tested', polarity: 'supported', verdict: 'pass', detail: '' },
    merged: { gate: 'merged', polarity: 'supported', verdict: 'pass', detail: '' },
    shipped: { gate: 'shipped', polarity: 'supported', verdict: 'pass', detail: '' },
    survived: { gate: 'survived', polarity: 'unknown', verdict: 'unknown', detail: '' },
    clean: { gate: 'clean', polarity: 'supported', verdict: 'pass', detail: '' },
  }).status, 'unresolved');
  const adaptedFunnel = evaluateCodingOutcome({
    proposed: { gate: 'proposed', polarity: 'supported', verdict: 'pass', detail: 'proposal' },
    accepted: { gate: 'accepted', polarity: 'supported', verdict: 'pass', detail: 'acceptance' },
    committed: { gate: 'committed', polarity: 'supported', verdict: 'pass', detail: 'commit' },
    tested: { gate: 'tested', polarity: 'supported', verdict: 'pass', detail: 'tests' },
    merged: { gate: 'merged', polarity: 'supported', verdict: 'pass', detail: 'merge' },
    shipped: { gate: 'shipped', polarity: 'supported', verdict: 'pass', detail: 'ship' },
    survived: { gate: 'survived', polarity: 'supported', verdict: 'pass', detail: 'survive' },
    clean: { gate: 'clean', polarity: 'supported', verdict: 'pass', detail: 'clean' },
  });
  assert.equal(adaptedFunnel.funnel.realized, true);
  assert.deepEqual(adaptedFunnel.funnel.results.map((result) => result.detail), [
    'proposal', 'acceptance', 'commit', 'tests', 'merge', 'ship', 'survive', 'clean',
  ]);
  assert.equal(evaluateCodingOutcome({
    proposed: { gate: 'proposed', polarity: 'supported', verdict: 'pass', detail: '' },
    accepted: { gate: 'accepted', polarity: 'supported', verdict: 'pass', detail: '' },
    committed: { gate: 'committed', polarity: 'supported', verdict: 'pass', detail: '' },
    tested: { gate: 'tested', polarity: 'conflicted', verdict: 'fail', detail: '' },
    merged: { gate: 'merged', polarity: 'supported', verdict: 'pass', detail: '' },
    shipped: { gate: 'shipped', polarity: 'supported', verdict: 'pass', detail: '' },
    survived: { gate: 'survived', polarity: 'supported', verdict: 'pass', detail: '' },
    clean: { gate: 'clean', polarity: 'supported', verdict: 'pass', detail: '' },
  }).status, 'conflicted');
});

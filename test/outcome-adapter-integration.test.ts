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

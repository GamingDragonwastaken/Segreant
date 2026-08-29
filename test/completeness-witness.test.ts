import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';
import {
  assessCompleteness,
  completenessWitness,
  type NegativeClaimTarget,
} from '../src/measurement/completeness.ts';

const target: NegativeClaimTarget = {
  eventType: 'linked_incident',
  scope: scope({ organization: 'acme', project: 'atlas' }),
  period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
};

test('absence is not inferable when there is no completeness witness', () => {
  const result = assessCompleteness(target, []);
  assert.equal(result.qualifiesAbsenceInference, false);
  assert.deepEqual(result.qualifyingWitnessIds, []);
});

test('only supported completeness can qualify a negative claim', () => {
  const base = {
    id: 'incident-feed',
    sourceId: 'pager',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  } as const;

  assert.equal(assessCompleteness(target, [completenessWitness({ ...base, state: 'unknown' })]).qualifiesAbsenceInference, false);
  assert.equal(assessCompleteness(target, [completenessWitness({ ...base, state: 'conflicted' })]).qualifiesAbsenceInference, false);
  assert.equal(assessCompleteness(target, [completenessWitness({ ...base, state: 'refuted' })]).qualifiesAbsenceInference, false);
  assert.equal(assessCompleteness(target, [completenessWitness({ ...base, state: 'supported' })]).qualifiesAbsenceInference, true);
});

test('completeness witness must cover event type, scope, and entire period', () => {
  const good = completenessWitness({
    id: 'good', sourceId: 'pager', state: 'supported', eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });
  const wrongEvent = completenessWitness({ ...good, id: 'wrong-event', eventTypes: ['deployment'] });
  const tooNarrow = completenessWitness({
    ...good, id: 'too-narrow', scope: scope({ organization: 'acme', project: 'other' }),
  });
  const tooShort = completenessWitness({
    ...good, id: 'too-short', period: interval('2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
  });

  assert.equal(assessCompleteness(target, [wrongEvent]).qualifiesAbsenceInference, false);
  assert.equal(assessCompleteness(target, [tooNarrow]).qualifiesAbsenceInference, false);
  assert.equal(assessCompleteness(target, [tooShort]).qualifiesAbsenceInference, false);
  assert.deepEqual(assessCompleteness(target, [good]).qualifyingWitnessIds, ['good']);
});

test('completeness witness canonicalizes event types and rejects duplicate or empty identity', () => {
  const witness = completenessWitness({
    id: 'w1', sourceId: 'pager', state: 'supported', eventTypes: ['revert', 'incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  });
  assert.deepEqual(witness.eventTypes, ['incident', 'revert']);
  assert.throws(() => completenessWitness({ ...witness, id: '' }), /id must be non-empty/);
  assert.throws(() => completenessWitness({ ...witness, eventTypes: ['incident', 'incident'] }), /duplicate event type/);
});

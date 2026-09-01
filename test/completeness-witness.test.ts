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

// ---------------------------------------------------------------------------
// Completeness itself can be contradicted (AII-003, WP-B03).
// ---------------------------------------------------------------------------

test('a refuting witness cannot be silently outvoted by a supporting one', () => {
  // Before this, `witnessCovers` dropped every non-`supported` witness with the
  // same test that dropped an irrelevant one. So a target with one witness
  // saying the feed was complete and another saying it was not qualified on the
  // strength of the supporter alone — a contradiction resolved silently, in the
  // most permissive direction, at the gate that decides whether "no incident
  // was observed" may become "no incident occurred".
  const supporting = completenessWitness({
    id: 'incident-feed-complete',
    sourceId: 'pager',
    state: 'supported',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });
  const refuting = completenessWitness({
    id: 'incident-feed-gap',
    sourceId: 'pager-audit',
    state: 'refuted',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  });

  const alone = assessCompleteness(target, [supporting]);
  assert.equal(alone.qualifiesAbsenceInference, true, 'the supporting witness works on its own');
  assert.equal(alone.state, 'supported');

  const contested = assessCompleteness(target, [supporting, refuting]);
  assert.equal(contested.state, 'conflicted');
  assert.equal(contested.qualifiesAbsenceInference, false, 'a contested completeness cannot license an absence inference');
  assert.deepEqual(contested.qualifyingWitnessIds, ['incident-feed-complete']);
  assert.deepEqual(contested.conflictingWitnessIds, ['incident-feed-gap'], 'and the disagreement is named, not just counted');
});

test('incompleteness inherits upward, completeness downward — not the other way round', () => {
  // The asymmetry is the substance of the fix, so it is pinned in both
  // directions rather than assumed from the implementation.
  const narrowTarget: NegativeClaimTarget = {
    eventType: 'linked_incident',
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  };

  // A gap SOMEWHERE in the quarter says nothing about these two days: the gap
  // may lie elsewhere. This must not refute the narrow target.
  const broadGap = completenessWitness({
    id: 'quarter-gap',
    sourceId: 'pager-audit',
    state: 'refuted',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });
  const narrowSupport = completenessWitness({
    id: 'two-day-complete',
    sourceId: 'pager',
    state: 'supported',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  });

  const narrow = assessCompleteness(narrowTarget, [narrowSupport, broadGap]);
  assert.equal(narrow.state, 'supported', 'a gap elsewhere in a broader window does not contradict this one');
  assert.equal(narrow.qualifiesAbsenceInference, true);
  assert.deepEqual(narrow.conflictingWitnessIds, []);

  // And the mirror: a two-day gap DOES contradict a claim about the month that
  // contains it.
  const monthly = assessCompleteness(target, [
    completenessWitness({
      id: 'month-complete',
      sourceId: 'pager',
      state: 'supported',
      eventTypes: ['linked_incident'],
      scope: scope({ organization: 'acme', project: 'atlas' }),
      period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
    }),
    completenessWitness({
      id: 'two-day-gap',
      sourceId: 'pager-audit',
      state: 'refuted',
      eventTypes: ['linked_incident'],
      scope: scope({ organization: 'acme', project: 'atlas' }),
      period: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
    }),
  ]);
  assert.equal(monthly.state, 'conflicted');
  assert.equal(monthly.qualifiesAbsenceInference, false);
});

test('a witness whose own completeness is conflicted cannot license an absence inference either', () => {
  const contested = completenessWitness({
    id: 'feed-itself-contested',
    sourceId: 'pager',
    state: 'conflicted',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  });
  const result = assessCompleteness(target, [contested]);
  assert.equal(result.state, 'refuted', 'no support, and something bearing against it');
  assert.equal(result.qualifiesAbsenceInference, false);
  assert.deepEqual(result.conflictingWitnessIds, ['feed-itself-contested']);
});

test('an unrelated refuting witness is still simply irrelevant', () => {
  // Non-vacuity: the new path must not refuse everything that is not supported.
  const otherChannel = completenessWitness({
    id: 'revert-scan-gap',
    sourceId: 'git',
    state: 'refuted',
    eventTypes: ['commit_reverted'],
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
  });
  const supporting = completenessWitness({
    id: 'incident-feed-complete',
    sourceId: 'pager',
    state: 'supported',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });

  const result = assessCompleteness(target, [supporting, otherChannel]);
  assert.equal(result.state, 'supported', 'a gap in a different event channel is not a contradiction here');
  assert.equal(result.qualifiesAbsenceInference, true);
  assert.deepEqual(result.conflictingWitnessIds, []);
});

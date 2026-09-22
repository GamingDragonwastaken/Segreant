import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent, type EconomicEventInput } from '../src/economics/events.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';

const START = Date.parse('2026-08-01T00:00:00.000Z');
const END = Date.parse('2026-08-02T00:00:00.000Z');

function charge(
  id: string,
  occurredAt = '2026-08-01T12:00:00.000Z',
  recordedAt = '2026-08-01T12:01:00.000Z',
  amount = '1',
): EconomicEventInput {
  return {
    id,
    kind: 'charge_estimated',
    subject: 'request:' + id,
    occurredAt,
    recordedAt,
    amount: money(amount, 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: id },
    schemaVersion: 1,
  };
}

test('period finalization binds an exact snapshot and blocks late in-period events', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const first = economicEvent(charge('close:first', '2026-08-01T09:00:00.000Z'));
  const second = economicEvent(charge('close:second', '2026-08-01T10:00:00.000Z', '2026-08-01T10:01:00.000Z', '2'));
  const outside = economicEvent(charge('close:outside', '2026-08-02T00:00:00.000Z', '2026-08-02T00:01:00.000Z', '9'));
  ledger.append(first);
  ledger.append(second);
  ledger.append(outside);

  assert.equal(ledger.periodCloseStatus(START, END).status, 'open');
  assert.equal(ledger.periodCloseStatus(START, END, '2026-08-02T12:00:00.000Z').status, 'open');

  const closed = ledger.finalizePeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.equal(closed.status, 'finalized');
  assert.equal(closed.eventCount, 2);
  assert.deepEqual(closed.sourceEventIds, [first.id, second.id].sort());
  assert.match(closed.projectionDigest, /^[a-f0-9]{64}$/);
  assert.equal(closed.balances.length, 1);
  assert.equal(formatMoneyAmount(closed.balances[0]!.amount), '3');

  const current = ledger.periodCloseStatus(START, END);
  assert.equal(current.status, 'finalized');
  assert.equal(current.activeFinalizationId, closed.eventId);
  assert.equal(current.projectionDigest, closed.projectionDigest);
  assert.equal(current.eventCount, 2);
  assert.equal(ledger.append(first), 'duplicate', 'replaying an existing event remains idempotent after close');
  assert.throws(
    () => ledger.append(charge('close:late', '2026-08-01T11:00:00.000Z', '2026-08-03T00:00:01.000Z')),
    /period.*finalized|reopen/i,
  );
  assert.equal(ledger.periodCloseStatus(START, END, '2026-08-02T23:59:59.999Z').status, 'open');
  assert.equal(ledger.periodCloseStatus(START, END, '2026-08-03T00:00:00.000Z').status, 'finalized');
  db.close();
});

test('reopening is explicit, preserves close history, and permits a re-finalization with a new digest', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  ledger.append(economicEvent(charge('reopen:first')));
  const firstClose = ledger.finalizePeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:00:00.000Z',
  });

  const reopened = ledger.reopenPeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:01:00.000Z',
    reason: 'late provider evidence',
  });
  assert.equal(reopened.status, 'reopened');
  assert.equal(reopened.reopenedFinalizationId, firstClose.eventId);
  assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');
  assert.equal(ledger.periodCloseStatus(START, END).activeFinalizationId, null);

  const late = economicEvent(charge('reopen:late', '2026-08-01T11:00:00.000Z', '2026-08-03T00:01:01.000Z', '4'));
  assert.equal(ledger.append(late), 'inserted');
  const secondClose = ledger.finalizePeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:02:00.000Z',
  });
  assert.equal(secondClose.status, 'finalized');
  assert.equal(secondClose.eventCount, 2);
  assert.notEqual(secondClose.eventId, firstClose.eventId);
  assert.notEqual(secondClose.projectionDigest, firstClose.projectionDigest);
  assert.equal(secondClose.balances.length, 1);
  assert.equal(formatMoneyAmount(secondClose.balances[0]!.amount), '5');
  assert.equal(ledger.events().filter((event) => event.kind === 'close_finalized').length, 2);
  assert.equal(ledger.events().filter((event) => event.kind === 'close_reopened').length, 1);
  db.close();
});

test('malformed close control events cannot be persisted as a period state', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const malformed = economicEvent({
    id: 'close:malformed',
    kind: 'close_finalized',
    subject: 'period:wrong',
    occurredAt: new Date(END).toISOString(),
    recordedAt: '2026-08-03T00:00:00.000Z',
    amount: null,
    sourceEventIds: [],
    reversalOf: null,
    metadata: {
      closeSchemaVersion: 1,
      periodStartMs: START,
      periodEndMs: END,
      projectionDigest: '0'.repeat(64),
      eventCount: 0,
    },
    schemaVersion: 1,
  });
  assert.throws(() => ledger.append(malformed), /period|close|projection/i);
  db.close();
});

test('competing finalizations are surfaced as conflicted and keep late evidence blocked', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const source = economicEvent(charge('conflict:source'));
  ledger.append(source);
  const first = ledger.finalizePeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:00:00.000Z',
  });

  // A second independently-authored close with the same snapshot is still a
  // valid immutable event, but it is not a valid lifecycle transition. The
  // replay state must preserve that conflict rather than selecting a winner.
  ledger.append(economicEvent({
    id: 'close:competing-finalization',
    kind: 'close_finalized',
    subject: 'economic-period:' + START + ':' + END,
    occurredAt: '2026-08-02T00:00:00.000Z',
    recordedAt: '2026-08-03T00:00:01.000Z',
    amount: null,
    sourceEventIds: [source.id],
    reversalOf: null,
    metadata: {
      closeSchemaVersion: 1,
      periodStartMs: START,
      periodEndMs: END,
      projectionDigest: first.projectionDigest,
      eventCount: 1,
    },
    schemaVersion: 1,
  }));

  const status = ledger.periodCloseStatus(START, END);
  assert.equal(status.status, 'conflicted');
  assert.equal(status.activeFinalizationId, first.eventId);
  assert.equal(status.latestFinalizationId, 'close:competing-finalization');
  assert.throws(
    () => ledger.append(economicEvent(charge('conflict:late', '2026-08-01T13:00:00.000Z', '2026-08-03T00:01:00.000Z'))),
    /conflicted|reopen|finalized/i,
  );
  assert.throws(
    () => ledger.reopenPeriod({ periodStartMs: START, periodEndMs: END, recordedAt: '2026-08-04T00:00:00.000Z', reason: 'cannot choose a conflicting close' }),
    /not actively finalized|conflict/i,
  );
  db.close();
});

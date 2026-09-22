import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { ECONOMIC_EVENT_KINDS, economicEvent, economicEventRole, type EconomicEventInput } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';
import { serializeEconomicEvent } from '../src/economics/serialization.ts';

const START = Date.parse('2026-08-01T00:00:00.000Z');
const END = Date.parse('2026-08-02T00:00:00.000Z');

function charge(id: string, occurredAt: string, recordedAt: string, amount = '1'): EconomicEventInput {
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

function brickedLedger(db: DatabaseSync): { ledger: EconomicLedger; closeId: string } {
  const ledger = new EconomicLedger(db);
  ledger.append(economicEvent(charge('c:first', '2026-08-01T09:00:00.000Z', '2026-08-01T09:01:00.000Z')));
  const close = ledger.finalizePeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:00:00.000Z',
  });
  ledger.reopenPeriod({
    periodStartMs: START,
    periodEndMs: END,
    recordedAt: '2026-08-03T00:01:00.000Z',
    reason: 'late provider evidence',
  });
  const late = economicEvent(charge('c:legacy-backdated', '2026-08-01T11:00:00.000Z', '2026-08-02T12:00:00.000Z', '4'));
  const encoded = serializeEconomicEvent(late);
  db.prepare(
    'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(late.id, late.kind, late.subject, late.occurredAt, late.recordedAt, encoded.body, encoded.digest);
  return { ledger, closeId: close.eventId };
}

test('the close invalidation control kind has an explicit control role', () => {
  assert.ok((ECONOMIC_EVENT_KINDS as readonly string[]).includes('close_invalidated'));
  assert.equal(economicEventRole('close_invalidated' as never), 'control');
});

test('explicit recovery invalidates a bricked close without rewriting history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger, closeId } = brickedLedger(db);
    assert.throws(() => ledger.events(), /bind every in-period event|close/i);

    const recovered = ledger.recoverBrickedPeriod({
      periodStartMs: START,
      periodEndMs: END,
      closeEventId: closeId,
      recordedAt: '2026-08-04T00:00:00.000Z',
      reason: 'repair legacy backdated append',
      id: 'close:recovery:legacy-backdated',
    });

    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.invalidatedFinalizationId, closeId);
    assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');
    assert.equal(ledger.read(closeId)!.sourceEventIds.length, 1);
    assert.equal(ledger.read(recovered.eventId)!.kind, 'close_invalidated');
    assert.equal(ledger.events().length, 5);

    const refinalized = ledger.finalizePeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-04T00:01:00.000Z',
    });
    assert.equal(refinalized.eventCount, 2);
    assert.deepEqual(refinalized.sourceEventIds, ['c:first', 'c:legacy-backdated'].sort());
  } finally {
    db.close();
  }
});

test('recovery refuses a close from another period', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger, closeId } = brickedLedger(db);
    assert.throws(
      () => ledger.recoverBrickedPeriod({
        periodStartMs: START,
        periodEndMs: END + 86_400_000,
        closeEventId: closeId,
        recordedAt: '2026-08-04T00:00:00.000Z',
        reason: 'wrong period',
      }),
      /period|close/i,
    );
  } finally {
    db.close();
  }
});

function invalidation(closeId: string, id = 'close:forged-invalidation') {
  return economicEvent({
    id,
    kind: 'close_invalidated',
    subject: 'period:close',
    occurredAt: '2026-08-02T00:00:00.000Z',
    recordedAt: '2026-08-04T00:00:00.000Z',
    amount: null,
    sourceEventIds: [closeId],
    reversalOf: null,
    metadata: {
      closeSchemaVersion: 1,
      periodStartMs: START,
      periodEndMs: END,
      closeEventId: closeId,
      reason: 'forged direct append',
    },
    schemaVersion: 1,
  });
}

test('close invalidation cannot be appended through the ordinary persistence boundary', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(economicEvent(charge('c:valid', '2026-08-01T09:00:00.000Z', '2026-08-01T09:01:00.000Z')));
    const close = ledger.finalizePeriod({ periodStartMs: START, periodEndMs: END, recordedAt: '2026-08-03T00:00:00.000Z' });
    assert.throws(() => ledger.append(invalidation(close.eventId)), /only be issued by recoverBrickedPeriod/);
    db.exec('BEGIN');
    try {
      assert.throws(() => ledger.appendWithinTransaction(invalidation(close.eventId, 'close:forged-within')), /only be issued by recoverBrickedPeriod/);
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
});

test('recovery refuses a close whose binding is still verifiable', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(economicEvent(charge('c:valid-only', '2026-08-01T09:00:00.000Z', '2026-08-01T09:01:00.000Z')));
    const close = ledger.finalizePeriod({ periodStartMs: START, periodEndMs: END, recordedAt: '2026-08-03T00:00:00.000Z' });
    assert.throws(
      () => ledger.recoverBrickedPeriod({
        periodStartMs: START,
        periodEndMs: END,
        closeEventId: close.eventId,
        recordedAt: '2026-08-04T00:00:00.000Z',
        reason: 'must not invalidate a valid close',
      }),
      /not bricked|verifiable/i,
    );
  } finally {
    db.close();
  }
});

test('a forged invalidation cannot launder a still-verifiable close on read', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(economicEvent(charge('c:forged', '2026-08-01T09:00:00.000Z', '2026-08-01T09:01:00.000Z')));
    const close = ledger.finalizePeriod({ periodStartMs: START, periodEndMs: END, recordedAt: '2026-08-03T00:00:00.000Z' });
    const forged = invalidation(close.eventId);
    const encoded = serializeEconomicEvent(forged);
    db.prepare(
      'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(forged.id, forged.kind, forged.subject, forged.occurredAt, forged.recordedAt, encoded.body, encoded.digest);
    db.prepare('INSERT INTO economic_event_sources (event_id, source_event_id) VALUES (?, ?)').run(forged.id, close.eventId);
    assert.throws(() => ledger.events(), /verifiable close/i);
  } finally {
    db.close();
  }
});

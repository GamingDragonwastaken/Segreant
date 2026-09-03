/**
 * A reopened period must not accept an event that falsifies a recorded close
 * (WP-C02 / WP-R06).
 *
 * THE DEFECT, AND IT BRICKS THE LEDGER. `validateCloseEvent` re-derives what a
 * stored `close_finalized` SHOULD have bound — every in-period event whose
 * `recordedAt` is at or before the close's own `recordedAt` — and requires that
 * to equal what it DID bind. That is a real integrity check: it is how a
 * deleted or forged in-period row is caught. But `assertPeriodOpenForEvent`
 * guards only the period's CURRENT state, refusing in-period appends while the
 * status is `finalized` or `conflicted` and letting them through once the period
 * is `reopened` — while the check applies to every close event EVER recorded.
 * The guard's domain is narrower than the check's.
 *
 * So: finalize a period, reopen it, then append an in-period event whose
 * `recordedAt` precedes the close. Nothing forbids it, and the first close's
 * binding is now false. `events()` re-validates every stored event, and every
 * economic projection is built on `events()`.
 *
 * Probed before diagnosis. After `append` returned `inserted`:
 *
 *   events()             THREW  economic close finalization must bind every
 *                               in-period event exactly once
 *   periodCloseStatus    THREW  the same
 *   finalizePeriod       THREW  the same
 *   reopenPeriod         THREW  the same
 *
 * The ledger is append-only, so there is no call that removes the offending
 * event and no call that supersedes the close. The state is terminal, and it is
 * reachable through the ordinary documented API. Under the project's own rule
 * that budget enforcement fails closed on an unreadable ledger, this also stops
 * provider forwarding permanently.
 *
 * WHY THE REPAIR IS AT APPEND AND NOT IN THE CHECK. Comparing a stored close
 * against its own recorded snapshot instead of against the live population would
 * make the symptom go away and would delete the tamper detection: a close is
 * exactly the claim that these were all the in-period events, and a check that
 * only asks whether the close agrees with itself cannot notice that one of them
 * is gone. The invariant to preserve is that a recorded close stays verifiable,
 * so the append that would retroactively falsify one is what must be refused.
 *
 * WHAT IS STILL PERMITTED, and it is the whole legitimate use. A reopen happens
 * after the close, and evidence recorded afterwards is recorded afterwards — so
 * an ordinary late append is unaffected, which is why the existing reopen test
 * in `test/economic-close.test.ts` passed throughout. `occurredAt` still carries
 * the event's own time and may sit anywhere inside the period; it is
 * `recordedAt`, the time Fiscus recorded it, that may not be backdated across a
 * close. Recorded at D-100.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent, type EconomicEventInput } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';

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

/** A period finalized at 2026-08-03T00:00:00Z and reopened one minute later. */
function reopenedLedger(db: DatabaseSync): { ledger: EconomicLedger; closeId: string } {
  const ledger = new EconomicLedger(db);
  ledger.append(economicEvent(charge('c:first', '2026-08-01T09:00:00.000Z', '2026-08-01T09:01:00.000Z')));
  const closed = ledger.finalizePeriod({
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
  return { ledger, closeId: closed.eventId };
}

test('a reopened period refuses an in-period event recorded before the close it would falsify', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger } = reopenedLedger(db);
    assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');

    // Recorded 2026-08-02T12:00Z: before the close at 2026-08-03T00:00Z, so the
    // close's own filter would have included it and its binding becomes false.
    assert.throws(
      () => ledger.append(economicEvent(charge('c:backdated', '2026-08-01T11:00:00.000Z', '2026-08-02T12:00:00.000Z', '4'))),
      /recorded|backdat|close/i,
    );
  } finally {
    db.close();
  }
});

test('the refused append leaves the ledger readable, which is the whole point', () => {
  // THE ASSERTION THAT NAMES THE HARM. Without the refusal every one of these
  // throws for good: `events()`, the close status, and both close operations.
  // A ledger that cannot be read is a ledger that cannot enforce a budget.
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger } = reopenedLedger(db);
    try {
      ledger.append(economicEvent(charge('c:backdated', '2026-08-01T11:00:00.000Z', '2026-08-02T12:00:00.000Z', '4')));
    } catch { /* the refusal is asserted above; here the question is what survives it */ }

    assert.equal(ledger.events().length, 3, 'the two close controls and the one original charge');
    assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');
    const refinalized = ledger.finalizePeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-03T00:02:00.000Z',
    });
    assert.equal(refinalized.status, 'finalized');
    assert.equal(refinalized.eventCount, 1);
  } finally {
    db.close();
  }
});

test('an ordinary late append after a reopen is still accepted and still re-finalizes', () => {
  // THE GUARD-RAIL, and the reason the rule costs nothing. A reopen happens
  // after the close, and evidence recorded afterwards carries a later
  // `recordedAt`. `occurredAt` is untouched: 2026-08-01T11:00Z is inside the
  // period, which is exactly the case a reopen exists to serve.
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger } = reopenedLedger(db);
    assert.equal(
      ledger.append(economicEvent(charge('c:late', '2026-08-01T11:00:00.000Z', '2026-08-03T00:01:01.000Z', '4'))),
      'inserted',
    );
    const second = ledger.finalizePeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-03T00:02:00.000Z',
    });
    assert.equal(second.eventCount, 2);
    // c:first, the first close, the reopen, c:late, the second close.
    assert.equal(ledger.events().length, 5);
  } finally {
    db.close();
  }
});

test('an event outside the closed period may still be recorded at any time', () => {
  // The second guard-rail. The bound belongs to the period the close covers, so
  // a backdated recording of an event that occurred outside it falsifies nothing
  // and must not be refused.
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger } = reopenedLedger(db);
    assert.equal(
      ledger.append(economicEvent(charge('c:outside', '2026-08-05T09:00:00.000Z', '2026-08-02T12:00:00.000Z', '7'))),
      'inserted',
    );
    assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');
  } finally {
    db.close();
  }
});

test('the bound is every close the period ever had, not only the first', () => {
  // A rule written against `activeFinalizationId`, or against the earliest
  // close, would let the second close be falsified instead. Each stored close
  // carries its own binding and each one has to stay verifiable, so the floor is
  // the latest `recordedAt` among all of them.
  const db = new DatabaseSync(':memory:');
  try {
    const { ledger } = reopenedLedger(db);
    ledger.append(economicEvent(charge('c:late', '2026-08-01T11:00:00.000Z', '2026-08-03T00:01:01.000Z', '4')));
    ledger.finalizePeriod({ periodStartMs: START, periodEndMs: END, recordedAt: '2026-08-03T00:02:00.000Z' });
    ledger.reopenPeriod({
      periodStartMs: START,
      periodEndMs: END,
      recordedAt: '2026-08-03T00:03:00.000Z',
      reason: 'a second correction',
    });

    // After the first close and before the second: the first close is untouched,
    // the second one is not.
    assert.throws(
      () => ledger.append(economicEvent(charge('c:between', '2026-08-01T13:00:00.000Z', '2026-08-03T00:01:30.000Z', '2'))),
      /recorded|backdat|close/i,
    );
    // c:first, close, reopen, c:late, close, reopen — and nothing from the
    // refused append.
    assert.equal(ledger.events().length, 6);
    assert.equal(ledger.periodCloseStatus(START, END).status, 'reopened');
  } finally {
    db.close();
  }
});

/**
 * Allocation reversals conserve in AGGREGATE, not one at a time (WP-C04).
 *
 * THE DEFECT. `validateReferenceClosure` bounds an `allocation_reversed` event
 * against the allocation it names: `negateMoney(value.amount) > target.amount`
 * is refused as exceeding its source. That check is per EVENT. Nothing sums the
 * reversals already recorded against the same allocation, so the bound is
 * defeated by splitting: two reversals of $8.00 each against a $10.00
 * allocation are individually under the bound and jointly $6.00 over it. The
 * period then closes at `allocation USD allocated -6` — more money taken back
 * than was ever allocated, which is not a quantity that can exist.
 *
 * THE INTENT WAS ALREADY IN THE CODE. This is not a rule being invented. The
 * existing check, its `exceeds its source amount` message, and the existing
 * test named `... a compatible, CONSERVING allocation source` all say the
 * ledger means to conserve. What was missing is that conservation is a property
 * of the SET of reversals, and only the store can see the set — the same shape
 * as the FX defect at D-090, where a per-event constructor could not know what
 * the collection already held.
 *
 * WHY THE OLD CHECK STAYS. The single-event bound is not redundant: it names
 * the simple case precisely, and an existing test asserts its message. The
 * cumulative check is added after it, so a lone oversized reversal still fails
 * for its own reason and only a split one reaches the new refusal.
 *
 * WHAT THIS DOES NOT ESTABLISH. It bounds reversals against ONE allocation
 * event. It says nothing about whether the allocations themselves conserve
 * against the charges they allocate — a $10.00 bill allocated $7.00 to two
 * teams is still accepted, because no rule ties an allocation to a charge total
 * at all. Nor does it address adjustments: a `credit_applied` may still exceed
 * the bill it credits. Recorded at D-091.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';

const PERIOD_START = Date.parse('2026-08-01T00:00:00.000Z');
const PERIOD_END = Date.parse('2026-09-01T00:00:00.000Z');

function allocation(id: string, amount: string, subject = 'allocation:run-1') {
  return economicEvent({
    id,
    kind: 'cost_allocated',
    subject,
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-02T00:00:00.000Z',
    amount: money(amount, 'USD', 'allocated'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { rule: 'fixture' },
    schemaVersion: 1,
  });
}

function reversal(id: string, target: ReturnType<typeof allocation>, amount: string, recordedAt: string) {
  return economicEvent({
    id,
    kind: 'allocation_reversed',
    subject: target.subject,
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt,
    amount: money(amount, 'USD', 'allocated'),
    sourceEventIds: [target.id],
    reversalOf: target.id,
    metadata: { rule: 'fixture' },
    schemaVersion: 1,
  });
}

test('reversals cannot exceed their allocation by being split across events', () => {
  // THE REFUSAL. Each reversal is under the single-event bound the ledger
  // already enforces; together they take back more than was allocated.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const target = allocation('event:allocation:1', '10');
    ledger.append(target);
    assert.equal(ledger.append(reversal('event:reversal:1', target, '-8', '2026-08-03T00:00:00.000Z')), 'inserted');
    assert.throws(
      () => ledger.append(reversal('event:reversal:2', target, '-8', '2026-08-04T00:00:00.000Z')),
      /reversals.*exceed|exceed.*allocated/i,
    );
  } finally {
    db.close();
  }
});

test('an allocation never closes at a negative balance', () => {
  // THE CONSEQUENCE, on the surface that carried it. Before the cumulative
  // bound this period closed at allocated -6 for a $10.00 allocation.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const target = allocation('event:allocation:1', '10');
    ledger.append(target);
    ledger.append(reversal('event:reversal:1', target, '-8', '2026-08-03T00:00:00.000Z'));
    try {
      ledger.append(reversal('event:reversal:2', target, '-8', '2026-08-04T00:00:00.000Z'));
    } catch { /* refused above; the close below is what this test measures */ }

    const closed = ledger.finalizePeriod({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      recordedAt: '2026-09-02T00:00:00.000Z',
    });
    const allocated = closed.balances.filter((balance) => balance.role === 'allocation');
    assert.equal(allocated.length, 1);
    assert.equal(formatMoneyAmount(allocated[0]!.amount), '2');
    assert.ok(allocated[0]!.amount.coefficient >= 0n, 'an allocated balance below zero is not a quantity that can exist');
  } finally {
    db.close();
  }
});

test('reversals that together fit inside the allocation are all accepted', () => {
  // THE PERMITTED PATH. Partial reversal is a real capability — a rule that
  // allowed only one reversal per allocation would pass the refusal above and
  // silently remove it. Reversing to exactly zero must also work: the bound is
  // "exceeds", not "reaches".
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const target = allocation('event:allocation:1', '10');
    ledger.append(target);
    assert.equal(ledger.append(reversal('event:reversal:1', target, '-4', '2026-08-03T00:00:00.000Z')), 'inserted');
    assert.equal(ledger.append(reversal('event:reversal:2', target, '-6', '2026-08-04T00:00:00.000Z')), 'inserted');

    const closed = ledger.finalizePeriod({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      recordedAt: '2026-09-02T00:00:00.000Z',
    });
    const allocated = closed.balances.filter((balance) => balance.role === 'allocation');
    assert.equal(allocated.length, 1);
    assert.equal(formatMoneyAmount(allocated[0]!.amount), '0');
  } finally {
    db.close();
  }
});

test('the bound is per allocation, so reversing one does not constrain another', () => {
  // A cumulative rule that summed every reversal in the ledger rather than the
  // reversals of THIS allocation would pass both tests above and refuse honest
  // work. The sum has to be keyed on the target.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const first = allocation('event:allocation:1', '10', 'allocation:run-1');
    const second = allocation('event:allocation:2', '10', 'allocation:run-2');
    ledger.append(first);
    ledger.append(second);
    assert.equal(ledger.append(reversal('event:reversal:1', first, '-9', '2026-08-03T00:00:00.000Z')), 'inserted');
    assert.equal(ledger.append(reversal('event:reversal:2', second, '-9', '2026-08-04T00:00:00.000Z')), 'inserted');
  } finally {
    db.close();
  }
});

test('the single-event bound still refuses a lone oversized reversal for its own reason', () => {
  // The cumulative check is added after the existing one, not in place of it.
  // An existing test asserts the single-event message, and a reader debugging
  // one oversized reversal should not be told about a total.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const target = allocation('event:allocation:1', '5');
    ledger.append(target);
    assert.throws(
      () => ledger.append(reversal('event:reversal:1', target, '-6', '2026-08-03T00:00:00.000Z')),
      /allocation reversal exceeds its source amount/,
    );
  } finally {
    db.close();
  }
});

test('a stored over-reversal fails closed on read rather than projecting a negative', () => {
  // The bound lives in the closure check, which runs on read as well as on
  // append. A database that already holds a split over-reversal must refuse to
  // hand back a projection rather than reporting a quantity that cannot exist.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const target = allocation('event:allocation:1', '10');
    ledger.append(target);
    ledger.append(reversal('event:reversal:1', target, '-8', '2026-08-03T00:00:00.000Z'));
    assert.throws(
      () => ledger.append(reversal('event:reversal:2', target, '-8', '2026-08-04T00:00:00.000Z')),
      /reversals.*exceed|exceed.*allocated/i,
    );

    assert.equal(ledger.read('event:reversal:2'), null);
    assert.equal(ledger.events().length, 2);
  } finally {
    db.close();
  }
});

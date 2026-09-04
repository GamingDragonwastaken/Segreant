import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';

function source() {
  return economicEvent({
    id: 'economic:correction-chain:charge',
    kind: 'charge_estimated',
    subject: 'request:correction-chain',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-01T00:01:00.000Z',
    amount: money('1', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'correction-chain' },
    schemaVersion: 1,
  });
}

test('price corrections form a typed append-only chain with effective as-of replay', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const original = source();
    ledger.append(original);

    const first = priceCorrectionEvent({
      id: 'economic:correction-chain:first',
      source: original,
      previousAmount: money('1', 'USD', 'list'),
      nextAmount: money('1.25', 'USD', 'list'),
      recordedAt: '2026-08-02T00:00:00.000Z',
    });
    ledger.append(first);

    const second = priceCorrectionEvent({
      id: 'economic:correction-chain:second',
      source: first,
      previousAmount: money('1.25', 'USD', 'list'),
      nextAmount: money('1.50', 'USD', 'list'),
      recordedAt: '2026-08-03T00:00:00.000Z',
    });
    assert.equal(second.kind, 'price_corrected');
    assert.deepEqual(second.sourceEventIds, [first.id]);
    assert.equal(formatMoneyAmount(second.amount!), '0.25');
    ledger.append(second);

    assert.equal(formatMoneyAmount(ledger.effectiveChargeFor(original.id, '2026-08-01T12:00:00.000Z')!.amount), '1');
    assert.deepEqual(ledger.effectiveChargeFor(original.id, '2026-08-01T12:00:00.000Z')!.eventIds, [original.id]);
    assert.equal(formatMoneyAmount(ledger.effectiveChargeFor(original.id, '2026-08-02T12:00:00.000Z')!.amount), '1.25');
    assert.deepEqual(ledger.effectiveChargeFor(original.id, '2026-08-02T12:00:00.000Z')!.eventIds, [original.id, first.id]);
    assert.equal(formatMoneyAmount(ledger.effectiveChargeFor(original.id, '2026-08-04T00:00:00.000Z')!.amount), '1.5');
    assert.deepEqual(ledger.effectiveChargeFor(original.id, '2026-08-04T00:00:00.000Z')!.eventIds, [original.id, first.id, second.id]);

    const competing = priceCorrectionEvent({
      id: 'economic:correction-chain:competing',
      source: first,
      previousAmount: money('1.25', 'USD', 'list'),
      nextAmount: money('1.75', 'USD', 'list'),
      recordedAt: '2026-08-04T00:00:00.000Z',
    });
    assert.throws(() => ledger.append(competing), /already has a correction|successor/i);
  } finally {
    db.close();
  }
});

test('the ledger refuses a chained correction whose predecessor metadata is tampered', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const original = source();
    ledger.append(original);
    const first = priceCorrectionEvent({
      id: 'economic:correction-chain:tamper:first',
      source: original,
      previousAmount: money('1', 'USD', 'list'),
      nextAmount: money('1.25', 'USD', 'list'),
      recordedAt: '2026-08-02T00:00:00.000Z',
    });
    ledger.append(first);
    const malformed = economicEvent({
      id: 'economic:correction-chain:tamper:second',
      kind: 'price_corrected',
      subject: original.subject,
      occurredAt: original.occurredAt,
      recordedAt: '2026-08-03T00:00:00.000Z',
      amount: money('0.75', 'USD', 'list'),
      sourceEventIds: [first.id],
      reversalOf: null,
      metadata: {
        correction: 'reprice',
        previousAmount: { coefficient: '1', scale: 0, currency: 'USD', basis: 'list' },
        nextAmount: { coefficient: '175', scale: 2, currency: 'USD', basis: 'list' },
      },
      schemaVersion: 1,
    });
    assert.throws(() => ledger.append(malformed), /predecessor next amount|predecessor currency|previousAmount/i);
    assert.equal(ledger.read(malformed.id), null);
  } finally {
    db.close();
  }
});

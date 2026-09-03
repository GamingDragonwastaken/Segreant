/** Negative charge adjustments conserve against their referenced charge in aggregate. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { money } from '../src/economics/money.ts';

function bill(id = 'event:bill:adjustment') {
  return economicEvent({
    id,
    kind: 'bill_observed',
    subject: 'provider:openai:acct-1',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-02T00:00:00.000Z',
    amount: money('10', 'USD', 'billed'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { invoiceRef: 'invoice-adjustment' },
    schemaVersion: 1,
  });
}

function credit(id: string, source: ReturnType<typeof bill>, amount: string, kind: 'credit_applied' | 'discount_applied' = 'credit_applied') {
  return economicEvent({
    id,
    kind,
    subject: source.subject,
    occurredAt: source.occurredAt,
    recordedAt: id.endsWith('2') ? '2026-08-04T00:00:00.000Z' : '2026-08-03T00:00:00.000Z',
    amount: money(amount, 'USD', 'billed'),
    sourceEventIds: [source.id],
    reversalOf: source.id,
    metadata: { invoiceRef: 'invoice-adjustment' },
    schemaVersion: 1,
  });
}

test('negative charge adjustments cannot exceed their charge when split across events', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const source = bill();
    ledger.append(source);
    assert.equal(ledger.append(credit('event:credit:1', source, '-6')), 'inserted');
    assert.throws(
      () => ledger.append(credit('event:credit:2', source, '-6')),
      /adjustments.*exceed|exceed.*charge/i,
    );
  } finally {
    db.close();
  }
});

test('different negative adjustment kinds share the same charge bound', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const source = bill();
    ledger.append(source);
    assert.equal(ledger.append(credit('event:credit:1', source, '-6')), 'inserted');
    assert.throws(
      () => ledger.append(credit('event:discount:2', source, '-5', 'discount_applied')),
      /adjustments.*exceed|exceed.*charge/i,
    );
  } finally {
    db.close();
  }
});

test('a negative adjustment that exactly offsets a charge remains permitted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const source = bill();
    ledger.append(source);
    assert.equal(ledger.append(credit('event:credit:1', source, '-6')), 'inserted');
    assert.equal(ledger.append(credit('event:credit:2', source, '-4')), 'inserted');
  } finally {
    db.close();
  }
});

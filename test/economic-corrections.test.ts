import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { money, formatMoneyAmount } from '../src/economics/money.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';

function source() {
  return economicEvent({
    id: 'economic:request:correction:charge',
    kind: 'charge_estimated',
    subject: 'request:correction',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-01T00:01:00.000Z',
    amount: money('1', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'correction', via: 'proxy' },
    schemaVersion: 1,
  });
}

test('price correction is an exact signed delta with typed previous/new metadata', () => {
  const original = source();
  const correction = priceCorrectionEvent({
    id: 'economic:price-correction:1',
    source: original,
    previousAmount: money('1', 'USD', 'list'),
    nextAmount: money('1.25', 'USD', 'list'),
    recordedAt: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(correction.kind, 'price_corrected');
  assert.equal(correction.subject, original.subject);
  assert.equal(formatMoneyAmount(correction.amount!), '0.25');
  assert.deepEqual(correction.sourceEventIds, [original.id]);
  assert.equal(correction.reversalOf, null);
  assert.deepEqual(correction.metadata, {
    correction: 'reprice',
    previousAmount: { coefficient: '1', scale: 0, currency: 'USD', basis: 'list' },
    nextAmount: { coefficient: '125', scale: 2, currency: 'USD', basis: 'list' },
  });
});

test('economic ledger persists a correction separately and rejects cross-basis or malformed correction lineage', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const original = source();
  ledger.append(original);
  const correction = priceCorrectionEvent({
    id: 'economic:price-correction:2',
    source: original,
    previousAmount: original.amount!,
    nextAmount: money('1.25', 'USD', 'list'),
    recordedAt: '2026-08-02T00:00:00.000Z',
  });
  ledger.append(correction);
  assert.deepEqual(ledger.project().balances.map((balance) => ({ role: balance.role, basis: balance.basis, amount: formatMoneyAmount(balance.amount) })), [
    { role: 'charge', basis: 'list', amount: '1' },
    { role: 'price', basis: 'list', amount: '0.25' },
  ]);
  const repeated = priceCorrectionEvent({
    id: 'economic:price-correction:repeated',
    source: original,
    previousAmount: original.amount!,
    nextAmount: money('1.50', 'USD', 'list'),
    recordedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.throws(() => ledger.append(repeated), /already has a correction|one correction/i);
  assert.throws(
    () => priceCorrectionEvent({
      id: 'economic:price-correction:before-source',
      source: original,
      previousAmount: original.amount!,
      nextAmount: money('0.75', 'USD', 'list'),
      recordedAt: '2026-07-31T00:00:00.000Z',
    }),
    /precede.*source/i,
  );
  const provider = economicEvent({
    ...original,
    id: 'economic:provider-charge:correction-source',
    kind: 'provider_charge_observed',
    amount: money('1', 'USD', 'provider_observed'),
  });
  assert.throws(
    () => priceCorrectionEvent({
      id: 'economic:price-correction:cross-basis',
      source: original,
      previousAmount: original.amount!,
      nextAmount: money('2', 'USD', 'estimated'),
      recordedAt: '2026-08-02T00:00:00.000Z',
    }),
    /currency|basis|same/i,
  );
  assert.throws(
    () => priceCorrectionEvent({
      id: 'economic:price-correction:provider',
      source: provider,
      previousAmount: provider.amount!,
      nextAmount: money('1.25', 'USD', 'provider_observed'),
      recordedAt: '2026-08-02T00:00:00.000Z',
    }),
    /local.*charge_estimated/i,
  );
  const malformed = economicEvent({
    id: 'economic:price-correction:malformed',
    kind: 'price_corrected',
    subject: original.subject,
    occurredAt: original.occurredAt,
    recordedAt: '2026-08-03T00:00:00.000Z',
    amount: money('0.25', 'USD', 'list'),
    sourceEventIds: [original.id],
    reversalOf: null,
    metadata: { correction: 'missing-typed-values' },
    schemaVersion: 1,
  });
  assert.throws(() => ledger.append(malformed), /previousAmount|nextAmount|correction/i);
  db.close();
});

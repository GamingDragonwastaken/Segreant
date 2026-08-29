import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent, type EconomicEventInput } from '../src/economics/events.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';
import { deserializeEconomicEvent, serializeEconomicEvent } from '../src/economics/serialization.ts';
import { canonicalJson } from '../src/epistemic/serialization.ts';
import { Store } from '../src/store/db.ts';

function event(overrides: Partial<EconomicEventInput> = {}): EconomicEventInput {
  return {
    id: 'event:bill:1',
    kind: 'bill_observed',
    subject: 'provider:openai:acct-1',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-02T00:00:00.000Z',
    amount: money('12.34', 'USD', 'billed'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { invoiceRef: 'invoice-1' },
    schemaVersion: 1,
    ...overrides,
  };
}

function withBody(encoded: ReturnType<typeof serializeEconomicEvent>, body: string): ReturnType<typeof serializeEconomicEvent> {
  return {
    ...encoded,
    body,
    digest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
  };
}

test('economic events are immutable, typed, and preserve exact Money basis', () => {
  const value = economicEvent(event());
  assert.equal(value.kind, 'bill_observed');
  assert.equal(value.amount?.basis, 'billed');
  assert.equal(formatMoneyAmount(value.amount!), '12.34');
  assert.equal(value.reversalOf, null);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.metadata), true);
  assert.throws(() => economicEvent(event({ amount: null })), /requires an amount/);
  assert.throws(() => economicEvent(event({ kind: 'allocation_reversed', reversalOf: null })), /reversalOf/);
  assert.throws(() => economicEvent({ ...event(), trusted: true } as never), /unknown field: trusted/);
});

test('economic serialization canonicalizes Money without BigInt or float coercion', () => {
  const value = economicEvent(event({ amount: money('0.000001', 'USD', 'provider_observed') }));
  const encoded = serializeEconomicEvent(value);
  assert.equal(encoded.kind, 'economic_event');
  assert.match(encoded.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(deserializeEconomicEvent(encoded), value);
  assert.equal(encoded.body.includes('BigInt'), false);
  assert.throws(() => deserializeEconomicEvent({ ...encoded, digest: 'sha256:' + '0'.repeat(64) }), /digest/);
});

test('economic deserialization refuses non-canonical Money and incomplete event bodies', () => {
  const encoded = serializeEconomicEvent(economicEvent(event()));
  const extraMoney = JSON.parse(encoded.body) as Record<string, unknown>;
  extraMoney.amount = { ...(extraMoney.amount as Record<string, unknown>), extra: 'smuggled' };
  assert.throws(
    () => deserializeEconomicEvent(withBody(encoded, canonicalJson(extraMoney))),
    /unknown.*Money|Money.*unknown/i,
  );

  const nonNormalized = JSON.parse(encoded.body) as Record<string, unknown>;
  nonNormalized.amount = { ...(nonNormalized.amount as Record<string, unknown>), coefficient: '100', scale: 2 };
  assert.throws(
    () => deserializeEconomicEvent(withBody(encoded, canonicalJson(nonNormalized))),
    /canonical|normalized/i,
  );

  const incomplete = JSON.parse(encoded.body) as Record<string, unknown>;
  delete incomplete.sourceEventIds;
  assert.throws(
    () => deserializeEconomicEvent(withBody(encoded, canonicalJson(incomplete))),
    /missing.*sourceEventIds|required/i,
  );

  const missingEnvelopeField = { ...encoded } as Record<string, unknown>;
  delete missingEnvelopeField.digest;
  assert.throws(
    () => deserializeEconomicEvent(missingEnvelopeField as never),
    /missing.*digest|required/i,
  );
});

test('economic ledger is append-only, idempotent, and projects each monetary basis separately', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const bill = economicEvent(event());
  const credit = economicEvent(event({ id: 'event:credit:1', kind: 'credit_applied', amount: money('-1.00', 'USD', 'billed'), sourceEventIds: [bill.id], reversalOf: bill.id, recordedAt: '2026-08-03T00:00:00.000Z' }));
  const estimate = economicEvent(event({ id: 'event:estimate:1', kind: 'charge_estimated', amount: money('3.00', 'USD', 'estimated'), recordedAt: '2026-08-04T00:00:00.000Z' }));
  assert.equal(ledger.append(bill), 'inserted');
  assert.equal(ledger.append(bill), 'duplicate');
  assert.equal(ledger.append(credit), 'inserted');
  assert.equal(ledger.append(estimate), 'inserted');
  assert.throws(() => ledger.append(economicEvent(event({ amount: money('99.00', 'USD', 'billed') }))), /different economic event/);
  assert.deepEqual(ledger.project().balances.map((balance) => ({ basis: balance.amount.basis, amount: formatMoneyAmount(balance.amount) })), [
    { basis: 'billed', amount: '11.34' },
    { basis: 'estimated', amount: '3' },
  ]);
  assert.deepEqual(ledger.project('2026-08-02T12:00:00.000Z').balances.map((balance) => ({ basis: balance.amount.basis, amount: formatMoneyAmount(balance.amount) })), [
    { basis: 'billed', amount: '12.34' },
  ]);
  assert.throws(() => db.prepare("UPDATE economic_events SET event_json = '{}' WHERE event_id = ?").run(bill.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM economic_events WHERE event_id = ?").run(bill.id), /append-only/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)").run(bill.id, 'bill_observed', 'x', bill.occurredAt, bill.recordedAt, '{}', 'tampered'), /append-only/);
  db.close();
});

test('economic projection replay is deterministic and rejects cross-currency or cross-basis summation', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  ledger.append(economicEvent(event({ amount: money('1.00', 'EUR', 'billed'), id: 'event:eur:1' })));
  ledger.append(economicEvent(event({ amount: money('1.00', 'USD', 'billed'), id: 'event:usd:1' })));
  const first = ledger.project();
  const second = ledger.project();
  assert.deepEqual(second, first);
  assert.deepEqual(first.balances.map((balance) => `${balance.amount.currency}:${balance.amount.basis}`), ['EUR:billed', 'USD:billed']);
  db.close();
});

test('economic replay fails closed on persisted dangling source references', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const dangling = economicEvent(event({ id: 'event:dangling', sourceEventIds: ['event:missing'] }));
  const encoded = serializeEconomicEvent(dangling);
  db.prepare(
    'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(dangling.id, dangling.kind, dangling.subject, dangling.occurredAt, dangling.recordedAt, encoded.body, encoded.digest);
  assert.throws(() => ledger.read(dangling.id), /unknown source economic event|dangling/i);
  assert.throws(() => ledger.events(), /unknown source economic event|dangling/i);
  db.close();
});

test('economic replay fails closed on persisted reversal links that are not source references', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const invalid = economicEvent(event({ id: 'event:invalid-reversal', reversalOf: 'event:missing-source' }));
  const encoded = serializeEconomicEvent(invalid);
  db.prepare(
    'INSERT INTO economic_events (event_id, event_kind, subject, occurred_at, recorded_at, event_json, event_digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(invalid.id, invalid.kind, invalid.subject, invalid.occurredAt, invalid.recordedAt, encoded.body, encoded.digest);
  assert.throws(() => ledger.read(invalid.id), /reversalOf.*sourceEventIds/i);
  db.close();
});

test('Store exposes the economic ledger on the same SQLite handle without changing operational totals', () => {
  const store = new Store(':memory:');
  try {
    const bill = economicEvent(event({ id: 'event:store:bill', amount: money('2.50', 'USD', 'billed') }));
    assert.equal(store.economic().append(bill), 'inserted');
    assert.deepEqual(store.economic().project().balances.map((balance) => ({ basis: balance.amount.basis, amount: formatMoneyAmount(balance.amount) })), [
      { basis: 'billed', amount: '2.5' },
    ]);
    assert.equal(store.summary(0, Date.parse('2026-08-03T00:00:00.000Z')).costUsd, 0);
  } finally {
    store.close();
  }
});

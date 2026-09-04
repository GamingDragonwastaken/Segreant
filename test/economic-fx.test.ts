import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { exactRate } from '../src/economics/rate.ts';
import { fxTranslationEvent } from '../src/economics/fx.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';
import { interval } from '../src/epistemic/time.ts';

function source() {
  return economicEvent({
    id: 'economic:fx:source',
    kind: 'charge_estimated',
    subject: 'request:fx',
    occurredAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-03T00:00:00.000Z',
    amount: money('10', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'fx' },
    schemaVersion: 1,
  });
}

test('FX translation is an exact historical derivative with typed lineage', () => {
  const original = source();
  const translated = fxTranslationEvent({
    id: 'economic:fx:translation',
    source: original,
    rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR' }),
    rateSource: 'fixture:historical-fx',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(translated.kind, 'fx_translated');
  assert.equal(translated.subject, original.subject);
  assert.equal(translated.occurredAt, original.occurredAt);
  assert.equal(formatMoneyAmount(translated.amount!), '9.1');
  assert.equal(translated.amount?.currency, 'EUR');
  assert.equal(translated.amount?.basis, 'list');
  assert.deepEqual(translated.sourceEventIds, [original.id]);
  assert.equal(translated.reversalOf, null);
  assert.deepEqual(translated.metadata, {
    convention: 'source-to-target',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    rate: { denominator: '100', numerator: '91', sourceUnit: 'USD', targetUnit: 'EUR' },
    rateSource: 'fixture:historical-fx',
    rounding: 'none',
    sourceAmount: { coefficient: '10', scale: 0, currency: 'USD', basis: 'list' },
  });
});

test('FX translation preserves the exact rate validity interval in historical lineage', () => {
  const original = source();
  const db = new DatabaseSync(':memory:');
  try {
    const translated = fxTranslationEvent({
      id: 'economic:fx:valid-time',
      source: original,
      rate: exactRate({
        numerator: 91n,
        denominator: 100n,
        sourceUnit: 'USD',
        targetUnit: 'EUR',
        validTime: interval('2026-07-31T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      }),
      rateSource: 'fixture:historical-fx',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      recordedAt: '2026-08-04T00:00:00.000Z',
    });
    assert.deepEqual((translated.metadata as { rate?: unknown }).rate, {
      denominator: '100',
      numerator: '91',
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: {
        from: '2026-07-31T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
      },
    });
    const ledger = new EconomicLedger(db);
    ledger.append(original);
    ledger.append(translated);
    assert.deepEqual((ledger.read(translated.id)!.metadata as { rate?: unknown }).rate, (translated.metadata as { rate?: unknown }).rate);
  } finally {
    db.close();
  }
});

test('FX translation refuses malformed rate validity intervals', () => {
  assert.throws(() => fxTranslationEvent({
    id: 'economic:fx:invalid-valid-time',
    source: source(),
    rate: {
      numerator: 91n,
      denominator: 100n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: {
        from: '2026-08-02T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        unexpected: true,
      },
    } as ReturnType<typeof exactRate>,
    rateSource: 'fixture:historical-fx',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-04T00:00:00.000Z',
  }), /validTime/);
});

test('economic ledger requires FX source/rate lineage and keeps translation out of earlier as-of views', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  const original = source();
  const ungrounded = economicEvent({
    id: 'economic:fx:ungrounded',
    kind: 'fx_translated',
    subject: original.subject,
    occurredAt: original.occurredAt,
    recordedAt: '2026-08-04T00:00:00.000Z',
    amount: money('9.1', 'EUR', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: null,
    schemaVersion: 1,
  });
  assert.throws(() => ledger.append(ungrounded), /source|rate|historical|translation/i);

  ledger.append(original);
  const translated = fxTranslationEvent({
    id: 'economic:fx:translation:ledger',
    source: original,
    rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR' }),
    rateSource: 'fixture:historical-fx',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-04T00:00:00.000Z',
  });
  ledger.append(translated);
  assert.deepEqual(ledger.project('2026-08-03T12:00:00.000Z').eventIds, [original.id]);
  assert.deepEqual(ledger.project('2026-08-05T00:00:00.000Z').eventIds, [original.id, translated.id]);
  assert.equal(formatMoneyAmount(ledger.read(translated.id)!.amount!), '9.1');

  const malformed = economicEvent({
    id: 'economic:fx:malformed',
    kind: 'fx_translated',
    subject: original.subject,
    occurredAt: original.occurredAt,
    recordedAt: '2026-08-05T00:00:00.000Z',
    amount: money('9.1', 'EUR', 'list'),
    sourceEventIds: [original.id],
    reversalOf: null,
    metadata: {
      convention: 'source-to-target',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      rateSource: 'fixture:historical-fx',
      rounding: 'none',
    },
    schemaVersion: 1,
  });
  assert.throws(() => ledger.append(malformed), /sourceAmount|rate|metadata|historical/i);
  db.close();
});

test('FX translation refuses cross-basis, cross-currency, non-positive, and non-terminating conversions', () => {
  const original = source();
  assert.throws(
    () => fxTranslationEvent({
      id: 'economic:fx:cross-basis',
      source: original,
      rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR' }),
      rateSource: 'fixture:historical-fx',
      effectiveAt: original.occurredAt,
      recordedAt: '2026-08-04T00:00:00.000Z',
      targetBasis: 'estimated',
    } as never),
    /basis|target/i,
  );
  assert.throws(
    () => fxTranslationEvent({
      id: 'economic:fx:wrong-source-unit',
      source: original,
      rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'GBP', targetUnit: 'EUR' }),
      rateSource: 'fixture:historical-fx',
      effectiveAt: original.occurredAt,
      recordedAt: '2026-08-04T00:00:00.000Z',
    }),
    /source.*unit|currency/i,
  );
  assert.throws(
    () => fxTranslationEvent({
      id: 'economic:fx:negative-rate',
      source: original,
      rate: exactRate({ numerator: -91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR' }),
      rateSource: 'fixture:historical-fx',
      effectiveAt: original.occurredAt,
      recordedAt: '2026-08-04T00:00:00.000Z',
    }),
    /positive|rate/i,
  );
  assert.throws(
    () => fxTranslationEvent({
      id: 'economic:fx:non-terminating',
      source: original,
      rate: exactRate({ numerator: 1n, denominator: 3n, sourceUnit: 'USD', targetUnit: 'EUR' }),
      rateSource: 'fixture:historical-fx',
      effectiveAt: original.occurredAt,
      recordedAt: '2026-08-04T00:00:00.000Z',
    }),
    /non-terminating|rounding/i,
  );
});

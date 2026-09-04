import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economicEvent } from '../src/economics/events.ts';
import {
  exactRate,
  historicalRateBook,
  historicalRateBookFromJson,
  historicalRateBookToJson,
  selectHistoricalRate,
} from '../src/economics/rate.ts';
import { fxTranslationEventFromRateBook } from '../src/economics/fx.ts';
import { money } from '../src/economics/money.ts';
import { interval } from '../src/epistemic/time.ts';

test('historical FX selection is replay-safe and follows explicit supersession, not insertion order', () => {
  const validTime = interval('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
  const original = {
    id: 'fx-rate:usd-eur:2026-08-01:v1',
    rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR', validTime }),
    rateSource: 'fixture:provider-feed:v1',
    recordedAt: '2026-08-02T00:00:00.000Z',
    supersedes: null,
  };
  const correction = {
    id: 'fx-rate:usd-eur:2026-08-01:v2',
    rate: exactRate({ numerator: 89n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR', validTime }),
    rateSource: 'fixture:provider-feed:v2',
    recordedAt: '2026-08-04T00:00:00.000Z',
    supersedes: original.id,
  };

  // Deliberately reverse insertion order: the selector must use typed
  // supersession plus the recording boundary, never array order.
  const book = historicalRateBook([correction, original]);
  const beforeCorrection = selectHistoricalRate(book, {
    sourceUnit: 'USD',
    targetUnit: 'EUR',
    effectiveAt: '2026-08-02T12:00:00.000Z',
    asOf: '2026-08-03T00:00:00.000Z',
  });
  const afterCorrection = selectHistoricalRate(book, {
    sourceUnit: 'USD',
    targetUnit: 'EUR',
    effectiveAt: '2026-08-02T12:00:00.000Z',
    asOf: '2026-08-04T00:00:00.000Z',
  });

  assert.equal(beforeCorrection.id, original.id);
  assert.equal(beforeCorrection.rate.numerator, 91n);
  assert.equal(afterCorrection.id, correction.id);
  assert.equal(afterCorrection.rate.numerator, 89n);
});

test('rate-book translation uses only rate knowledge available at translation recording time', () => {
  const source = economicEvent({
    id: 'economic:rate-book:source',
    kind: 'charge_estimated',
    subject: 'request:rate-book',
    occurredAt: '2026-08-02T12:00:00.000Z',
    recordedAt: '2026-08-02T13:00:00.000Z',
    amount: money('10', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'rate-book' },
    schemaVersion: 1,
  });
  const validTime = interval('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
  const original = {
    id: 'fx-rate:book:original',
    rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR', validTime }),
    rateSource: 'fixture:rate-book:original',
    recordedAt: '2026-08-02T14:00:00.000Z',
    supersedes: null,
  };
  const correction = {
    id: 'fx-rate:book:correction',
    rate: exactRate({ numerator: 89n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR', validTime }),
    rateSource: 'fixture:rate-book:correction',
    recordedAt: '2026-08-06T14:00:00.000Z',
    supersedes: original.id,
  };
  const translated = fxTranslationEventFromRateBook({
    id: 'economic:rate-book:translation',
    source,
    targetUnit: 'EUR',
    rateBook: historicalRateBook([correction, original]),
    effectiveAt: '2026-08-02T12:00:00.000Z',
    recordedAt: '2026-08-05T00:00:00.000Z',
  });

  assert.equal(translated.amount?.coefficient, 91n);
  assert.equal((translated.metadata as { rateSource?: unknown }).rateSource, original.rateSource);
});

test('historical FX rate books refuse non-positive rates before selection', () => {
  assert.throws(() => historicalRateBook([{
    id: 'fx-rate:book:zero',
    rate: exactRate({
      numerator: 0n,
      denominator: 1n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
    }),
    rateSource: 'fixture:rate-book:zero',
    recordedAt: '2026-08-02T14:00:00.000Z',
    supersedes: null,
  }]), /positive/);
});

test('historical rate-book JSON preserves exact provenance and rejects tampering', () => {
  const book = historicalRateBook([{
    id: 'fx-rate:json:one',
    rate: exactRate({
      numerator: 9n,
      denominator: 10n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
    }),
    rateSource: 'fixture:rate-book:json',
    recordedAt: '2026-08-02T14:00:00.000Z',
    supersedes: null,
  }]);
  const encoded = historicalRateBookToJson(book);
  const decoded = historicalRateBookFromJson(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(historicalRateBookToJson(decoded), encoded);
  const tampered = JSON.parse(JSON.stringify(encoded)) as { observations: Array<{ rate: { numerator: string } }> };
  tampered.observations[0]!.rate.numerator = '09';
  assert.throws(() => historicalRateBookFromJson(tampered), /canonical integer/);
});

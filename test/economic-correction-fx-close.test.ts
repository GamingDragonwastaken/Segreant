import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { exactRate, historicalRateBook } from '../src/economics/rate.ts';
import { translateEffectiveChargeFromRateBook } from '../src/economics/fx.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';
import { interval } from '../src/epistemic/time.ts';

const RATE_VALID_TIME = interval('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z');

function source() {
  return economicEvent({
    id: 'economic:correction-fx-close:charge',
    kind: 'charge_estimated',
    subject: 'request:correction-fx-close',
    occurredAt: '2026-08-01T12:00:00.000Z',
    recordedAt: '2026-08-01T13:00:00.000Z',
    amount: money('10', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: 'correction-fx-close' },
    schemaVersion: 1,
  });
}

function rateBook() {
  const original = {
    id: 'fx-rate:correction-fx-close:original',
    rate: exactRate({ numerator: 9n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: RATE_VALID_TIME }),
    rateSource: 'fixture:correction-fx-close:original',
    recordedAt: '2026-08-01T14:00:00.000Z',
    supersedes: null,
  };
  const later = {
    id: 'fx-rate:correction-fx-close:later',
    rate: exactRate({ numerator: 8n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: RATE_VALID_TIME }),
    rateSource: 'fixture:correction-fx-close:later',
    recordedAt: '2026-08-03T14:00:00.000Z',
    supersedes: original.id,
  };
  return historicalRateBook([later, original]);
}

test('corrected effective FX replay uses the close knowledge boundary without rewriting the close', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const charge = source();
    ledger.append(charge);
    const correction = priceCorrectionEvent({
      id: 'economic:correction-fx-close:correction',
      source: charge,
      previousAmount: money('10', 'USD', 'list'),
      nextAmount: money('12', 'USD', 'list'),
      recordedAt: '2026-08-02T01:00:00.000Z',
    });
    ledger.append(correction);

    const close = ledger.finalizePeriod({
      id: 'economic:correction-fx-close:finalized',
      periodStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
      periodEndMs: Date.parse('2026-08-02T00:00:00.000Z'),
      recordedAt: '2026-08-02T02:00:00.000Z',
    });
    const book = rateBook();

    const atClose = ledger.effectiveFxChargeFor(
      charge.id,
      'EUR',
      book,
      undefined,
      close.recordedAt,
    );
    assert.ok(atClose);
    assert.equal(formatMoneyAmount(atClose.effectiveAmount), '12');
    assert.equal(formatMoneyAmount(atClose.translatedAmount), '10.8');
    assert.equal(atClose.translatedAmount.basis, 'effective');
    assert.deepEqual(atClose.eventIds, [charge.id, correction.id]);
    assert.equal(atClose.rateSource, 'fixture:correction-fx-close:original');
    assert.equal(atClose.rateAsOf, close.recordedAt);
    assert.throws(() => translateEffectiveChargeFromRateBook({
      source: charge,
      effectiveAmount: atClose.effectiveAmount,
      eventIds: atClose.eventIds,
      sourceBases: ['not-a-basis'] as never,
      targetUnit: 'EUR',
      rateBook: book,
      effectiveAt: charge.occurredAt,
      rateAsOf: close.recordedAt,
    }), /basis/i);

    const afterLaterRate = ledger.effectiveFxChargeFor(
      charge.id,
      'EUR',
      book,
      undefined,
      '2026-08-04T00:00:00.000Z',
    );
    assert.ok(afterLaterRate);
    assert.equal(formatMoneyAmount(afterLaterRate.translatedAmount), '9.6');
    assert.equal(afterLaterRate.rateSource, 'fixture:correction-fx-close:later');

    assert.equal(ledger.periodCloseStatus(
      Date.parse('2026-08-01T00:00:00.000Z'),
      Date.parse('2026-08-02T00:00:00.000Z'),
    ).projectionDigest, close.projectionDigest);
    assert.equal(ledger.read(close.eventId)!.metadata && typeof ledger.read(close.eventId)!.metadata === 'object', true);
  } finally {
    db.close();
  }
});

/** Economic derivative source links must conserve compatible meaning. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { economicEvent, type EconomicEvent, type EconomicEventInput } from '../src/economics/events.ts';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { exactRate } from '../src/economics/rate.ts';
import { fxTranslationEvent } from '../src/economics/fx.ts';
import { money } from '../src/economics/money.ts';

const OCCURRED_AT = '2026-08-01T00:00:00.000Z';
const SOURCE_RECORDED_AT = '2026-08-02T00:00:00.000Z';
const DERIVATIVE_RECORDED_AT = '2026-08-03T00:00:00.000Z';

function monetaryEvent(overrides: Partial<EconomicEventInput> = {}): EconomicEvent {
  return economicEvent({
    id: 'economic:source:guard',
    kind: 'charge_estimated',
    subject: 'request:source-link-guard',
    occurredAt: OCCURRED_AT,
    recordedAt: SOURCE_RECORDED_AT,
    amount: money('10', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { fixture: 'economic-source-link-guard' },
    schemaVersion: 1,
    ...overrides,
  });
}

function translation(id: string, source: EconomicEvent): EconomicEvent {
  return fxTranslationEvent({
    id,
    source,
    rate: exactRate({ numerator: 9n, denominator: 10n, sourceUnit: source.amount!.currency, targetUnit: 'EUR' }),
    rateSource: 'fixture:source-link-guard',
    effectiveAt: OCCURRED_AT,
    recordedAt: DERIVATIVE_RECORDED_AT,
  });
}

test('an FX translation cannot derive from a price-correction delta', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const source = monetaryEvent();
    ledger.append(source);
    const correction = priceCorrectionEvent({
      id: 'economic:source:guard:correction',
      source,
      previousAmount: money('10', 'USD', 'list'),
      nextAmount: money('11', 'USD', 'list'),
      recordedAt: DERIVATIVE_RECORDED_AT,
    });
    ledger.append(correction);

    const invalid = translation('economic:source:guard:translation-of-correction', correction);
    assert.throws(
      () => ledger.append(invalid),
      /FX translation source.*(charge|role|semantic)|incompatible.*source/i,
    );
    assert.equal(ledger.read(invalid.id), null);
  } finally {
    db.close();
  }
});

test('an FX translation refuses non-charge and non-translation monetary source roles', () => {
  const cases: ReadonlyArray<{ kind: EconomicEventInput['kind']; amount: ReturnType<typeof money> }> = [
    { kind: 'credit_applied', amount: money('-1', 'USD', 'list') },
    { kind: 'cost_allocated', amount: money('1', 'USD', 'allocated') },
  ];
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    for (const [index, item] of cases.entries()) {
      const source = monetaryEvent({
        id: `economic:source:guard:incompatible:${index}`,
        kind: item.kind,
        subject: `source-link-guard:${item.kind}`,
        amount: item.amount,
      });
      ledger.append(source);
      const invalid = translation(`economic:source:guard:incompatible:${index}:translation`, source);
      assert.throws(
        () => ledger.append(invalid),
        /FX translation source.*(charge|role|semantic)|incompatible.*source/i,
        `${item.kind} must not become a translation source`,
      );
      assert.equal(ledger.read(invalid.id), null);
    }
  } finally {
    db.close();
  }
});

test('an FX translation refuses a non-monetary usage observation as its source', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const usage = economicEvent({
      id: 'economic:source:guard:usage',
      kind: 'usage_observed',
      subject: 'source-link-guard:usage',
      occurredAt: OCCURRED_AT,
      recordedAt: SOURCE_RECORDED_AT,
      amount: null,
      sourceEventIds: [],
      reversalOf: null,
      metadata: { unit: 'tokens', quantity: '100' },
      schemaVersion: 1,
    });
    ledger.append(usage);
    const invalid = economicEvent({
      id: 'economic:source:guard:usage:translation',
      kind: 'fx_translated',
      subject: usage.subject,
      occurredAt: usage.occurredAt,
      recordedAt: DERIVATIVE_RECORDED_AT,
      amount: money('9', 'EUR', 'list'),
      sourceEventIds: [usage.id],
      reversalOf: null,
      metadata: {},
      schemaVersion: 1,
    });
    assert.throws(
      () => ledger.append(invalid),
      /FX translation.*(monetary source|charge|role|semantic)|incompatible.*source/i,
    );
    assert.equal(ledger.read(invalid.id), null);
  } finally {
    db.close();
  }
});

test('a price correction cannot use an FX translation as its charge source', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    const source = monetaryEvent();
    ledger.append(source);
    const translated = translation('economic:source:guard:translation', source);
    ledger.append(translated);
    const invalid = economicEvent({
      id: 'economic:source:guard:correction-of-translation',
      kind: 'price_corrected',
      subject: translated.subject,
      occurredAt: translated.occurredAt,
      recordedAt: '2026-08-04T00:00:00.000Z',
      amount: money('1', 'EUR', 'list'),
      sourceEventIds: [translated.id],
      reversalOf: null,
      metadata: {
        correction: 'reprice',
        previousAmount: { coefficient: '9', scale: 0, currency: 'EUR', basis: 'list' },
        nextAmount: { coefficient: '10', scale: 0, currency: 'EUR', basis: 'list' },
      },
      schemaVersion: 1,
    });
    assert.throws(() => ledger.append(invalid), /price correction.*(charge|source|local)/i);
    assert.equal(ledger.read(invalid.id), null);
  } finally {
    db.close();
  }
});

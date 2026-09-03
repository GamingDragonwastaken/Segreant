/**
 * One live translation per source and target currency (WP-C03).
 *
 * THE DEFECT. `fx_translated` is a DERIVATIVE: it restates one charge in a
 * second currency without the charge ceasing to be true. `closeBalances` groups
 * by `currency + basis + role` and sums within a group, so two translations of
 * one charge into one currency land in the same group and are added. A $10.00
 * bill translated at 0.9 and then again at 0.8 projected as EUR 17 — not one of
 * the two answers, and not a number any rate produces.
 *
 * WHY IT IS THE LEDGER'S JOB. `fxTranslationEvent` sees its own source and
 * nothing else; it cannot know a translation already exists. The uniqueness of a
 * derivative is a property of the STORE, so the persistence boundary is the only
 * place that can refuse it, and refusing inside the closure check means a
 * database that already holds the pair fails closed rather than projecting the
 * sum.
 *
 * IT IS A MISSING SIBLING, NOT A NEW RULE. `price_corrected` — the other kind
 * that derives one event from one source — has carried exactly this guard since
 * it was written: `price correction source ... already has a correction`. The
 * two kinds were given the same shape and only one was given the constraint,
 * which is why the last test here runs one scenario against both.
 *
 * DELIBERATELY STILL PERMITTED. Translating one charge into two DIFFERENT
 * currencies is not double counting: EUR and GBP are separate balance groups and
 * are never summed together. The rule is keyed on the pair, not on the source.
 *
 * WHAT THIS DOES NOT ESTABLISH. It does not give a corrected rate a way to
 * supersede a recorded translation. `price_corrected` has no supersession path
 * either — one correction per charge, and that is the repository's standing
 * stance rather than an oversight this test quietly widens. Recorded at D-090.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { exactRate } from '../src/economics/rate.ts';
import { fxTranslationEvent } from '../src/economics/fx.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';

const PERIOD_START = Date.parse('2026-08-01T00:00:00.000Z');
const PERIOD_END = Date.parse('2026-09-01T00:00:00.000Z');

function bill() {
  return economicEvent({
    id: 'economic:fx:bill',
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

function translation(id: string, numerator: bigint, targetUnit: string, recordedAt: string) {
  return fxTranslationEvent({
    id,
    source: bill(),
    rate: exactRate({ numerator, denominator: 100n, sourceUnit: 'USD', targetUnit }),
    rateSource: 'fixture:historical-fx',
    effectiveAt: '2026-08-01T00:00:00.000Z',
    recordedAt,
  });
}

test('a source already translated into a currency cannot be translated into it again', () => {
  // THE REFUSAL. Both events are individually well-formed: same source, same
  // target currency, different honest rates. Nothing but the store can see that
  // the pair is the problem.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    assert.equal(ledger.append(bill()), 'inserted');
    assert.equal(ledger.append(translation('economic:fx:t1', 90n, 'EUR', '2026-08-04T00:00:00.000Z')), 'inserted');
    assert.throws(
      () => ledger.append(translation('economic:fx:t2', 80n, 'EUR', '2026-08-05T00:00:00.000Z')),
      /is already translated into EUR/,
    );
  } finally {
    db.close();
  }
});

test('the projection reports one translation of a charge, not the sum of two', () => {
  // THE CONSEQUENCE, measured on the surface that carried it. Before the guard
  // this period closed at EUR 17 for a USD 10.00 bill.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(bill());
    ledger.append(translation('economic:fx:t1', 90n, 'EUR', '2026-08-04T00:00:00.000Z'));
    try {
      ledger.append(translation('economic:fx:t2', 80n, 'EUR', '2026-08-05T00:00:00.000Z'));
    } catch { /* refused above; the close below is what this test measures */ }

    const closed = ledger.finalizePeriod({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      recordedAt: '2026-09-02T00:00:00.000Z',
    });
    const translated = closed.balances.filter((balance) => balance.role === 'translation');
    assert.equal(translated.length, 1, 'exactly one translation group should exist');
    assert.equal(translated[0]!.currency, 'EUR');
    assert.equal(formatMoneyAmount(translated[0]!.amount), '9');
    assert.deepEqual([...translated[0]!.eventIds], ['economic:fx:t1']);

    // And the charge it derives from is untouched: a derivative never consumes
    // its source, which is why the two must not be added in the first place.
    const charge = closed.balances.filter((balance) => balance.role === 'charge');
    assert.equal(charge.length, 1);
    assert.equal(formatMoneyAmount(charge[0]!.amount), '10');
  } finally {
    db.close();
  }
});

test('one charge may still be translated into two different currencies', () => {
  // THE PERMITTED PATH. A rule keyed on the source alone would pass the refusal
  // test above and destroy a legitimate capability: EUR and GBP are different
  // balance groups and are never summed, so neither hides the other.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(bill());
    assert.equal(ledger.append(translation('economic:fx:eur', 90n, 'EUR', '2026-08-04T00:00:00.000Z')), 'inserted');
    assert.equal(ledger.append(translation('economic:fx:gbp', 80n, 'GBP', '2026-08-04T00:00:00.000Z')), 'inserted');

    const closed = ledger.finalizePeriod({
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      recordedAt: '2026-09-02T00:00:00.000Z',
    });
    const translated = closed.balances.filter((balance) => balance.role === 'translation');
    assert.deepEqual(translated.map((balance) => balance.currency).sort(), ['EUR', 'GBP']);
  } finally {
    db.close();
  }
});

test('the refused translation leaves no residue behind it', () => {
  // A guard that threw after writing would be worse than none: the pair would
  // be on disk and every later read would project their sum. The refusal has to
  // happen inside the append transaction, so nothing is persisted.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(bill());
    ledger.append(translation('economic:fx:t1', 90n, 'EUR', '2026-08-04T00:00:00.000Z'));
    assert.throws(
      () => ledger.append(translation('economic:fx:t2', 80n, 'EUR', '2026-08-05T00:00:00.000Z')),
      /is already translated into EUR/,
    );

    assert.equal(ledger.read('economic:fx:t2'), null);
    assert.equal(ledger.events().length, 2);
  } finally {
    db.close();
  }
});

test('both kinds that derive one event from one source refuse a second derivative', () => {
  // THE DEFECT CLASS. `price_corrected` and `fx_translated` are the two kinds
  // built as a single-source derivative, and the correction carried this guard
  // from the start while the translation did not. Running one scenario against
  // both is what stops the asymmetry from reopening.
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    ledger.append(bill());

    ledger.append(priceCorrectionEvent({
      id: 'economic:fx:fix1',
      source: bill(),
      previousAmount: money('10', 'USD', 'list'),
      nextAmount: money('11', 'USD', 'list'),
      recordedAt: '2026-08-04T00:00:00.000Z',
    }));
    assert.throws(
      () => ledger.append(priceCorrectionEvent({
        id: 'economic:fx:fix2',
        source: bill(),
        previousAmount: money('10', 'USD', 'list'),
        nextAmount: money('12', 'USD', 'list'),
        recordedAt: '2026-08-05T00:00:00.000Z',
      })),
      /already has a correction/,
    );

    ledger.append(translation('economic:fx:t1', 90n, 'EUR', '2026-08-04T00:00:00.000Z'));
    assert.throws(
      () => ledger.append(translation('economic:fx:t2', 80n, 'EUR', '2026-08-05T00:00:00.000Z')),
      /is already translated into EUR/,
    );
  } finally {
    db.close();
  }
});

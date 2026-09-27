/**
 * A RECEIPT IS RECONCILED AGAINST THE LEDGER IT SUMMARISES.
 *
 * WP-R06/C06 left "nothing reconciles a receipt or rollup against the ledger
 * it summarises" open. A v2 receipt carries the exact lineage it was built
 * from — the source and correction event ids the effective projection
 * retained, the effective amount, the source bases. That is enough to ask the
 * economic ledger the one question a holder of the receipt wants answered:
 * does the ledger, read now (or as of an instant), still say what the receipt
 * says?
 *
 * Four answers, kept apart because they mean different things:
 * `agrees` — every event is in the ledger and the effective projection over
 * the receipt's sources equals its amount with the same lineage;
 * `ledger_moved` — the sources are there and the receipt's own lineage still
 * resolves, but the ledger has since retained a correction the receipt never
 * saw, so the effective amount differs — the receipt was true when signed and
 * the ledger has moved on; `disagrees` — the ledger's effective lineage is
 * the receipt's and the amount still differs, or a source is missing, which
 * no later correction explains; `not_reconcilable` — a v1 receipt carries no
 * lineage, and a receipt from another ledger names events this one never had.
 *
 * `requestCount` is not checked: a receipt carries no window, so the ledger
 * cannot say how many rows the unit had. The result says so.
 *
 * RED against the unfixed tree: no such function existed. Recorded at D-231.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { addMoney, money } from '../src/economics/money.ts';
import { economicAttributionView } from '../src/economics/attribution.ts';
import { buildEconomicReceiptBody, buildReceiptBody } from '../src/value/receipt.ts';
import { reconcileReceiptWithLedger } from '../src/value/receiptReconciliation.ts';
import { gateResultFromVerdict, type FunnelOutcome } from '../src/value/gates.ts';

const funnel: FunnelOutcome = {
  realized: true, results: [gateResultFromVerdict('committed', 'pass', 'fixture')], conflicts: [], reachedIndex: 0,
  reached: 'committed', diedAt: null, diedAtIndex: null, passes: 1, fails: 0, unknowns: 0, instrumented: 1, realizationScore: 1,
};

function charge(id: string, amount: string) {
  return economicEvent({
    id, kind: 'charge_estimated', subject: `request:${id}`, occurredAt: '2026-08-01T00:00:00.000Z', recordedAt: '2026-08-01T00:01:00.000Z',
    amount: money(amount, 'USD', 'list'), sourceEventIds: [], reversalOf: null, metadata: { requestId: id, via: 'proxy' }, schemaVersion: 1,
  });
}

function ledgerWith(...events: ReturnType<typeof charge>[]): EconomicLedger {
  const ledger = new EconomicLedger(new DatabaseSync(':memory:'));
  for (const event of events) ledger.append(event);
  return ledger;
}

function receiptFor(ledger: EconomicLedger, sourceIds: readonly string[]) {
  const charges = ledger.effectiveChargesFor(sourceIds);
  let amount = money('0', 'USD', 'effective');
  const eventIds = new Set<string>();
  const bases = new Set<string>();
  for (const id of sourceIds) {
    const effective = charges.get(id);
    assert.ok(effective, `${id} must resolve in the fixture ledger`);
    amount = addMoney(amount, effective.amount);
    for (const eventId of effective.eventIds) eventIds.add(eventId);
    for (const basis of effective.sourceBases) bases.add(basis);
  }
  const economic = economicAttributionView({
    amount, eventIds: [...eventIds].sort(), sourceBases: [...bases].sort() as never, requestCount: sourceIds.length, unresolvedRequests: 0,
  });
  return buildEconomicReceiptBody('deadbeef', 'segreant', Number(economic.amountText), null, funnel, economic);
}

test('a receipt built from the ledger agrees with it', () => {
  const ledger = ledgerWith(charge('economic:request:a:charge', '1'), charge('economic:request:b:charge', '0.5'));
  const body = receiptFor(ledger, ['economic:request:a:charge', 'economic:request:b:charge']);
  const result = reconcileReceiptWithLedger(body, ledger);
  assert.equal(result.status, 'agrees');
  assert.equal(result.receiptAmountText, '1.5');
  assert.equal(result.ledgerAmountText, '1.5');
  assert.deepEqual(result.missingEventIds, []);
  assert.deepEqual(result.unseenEventIds, []);
  assert.match(result.notChecked.join(' '), /requestCount/);
});

test('a correction retained after signing reads as the ledger having moved, not as a disagreement', () => {
  const source = charge('economic:request:a:charge', '1');
  const ledger = ledgerWith(source);
  const body = receiptFor(ledger, [source.id]);
  ledger.append(priceCorrectionEvent({
    id: 'economic:price-correction:1', source, previousAmount: money('1', 'USD', 'list'), nextAmount: money('1.25', 'USD', 'list'),
    recordedAt: '2026-08-02T00:00:00.000Z',
  }));
  const moved = reconcileReceiptWithLedger(body, ledger);
  assert.equal(moved.status, 'ledger_moved');
  assert.equal(moved.receiptAmountText, '1');
  assert.equal(moved.ledgerAmountText, '1.25');
  assert.deepEqual(moved.unseenEventIds, ['economic:price-correction:1']);
  // As of an instant before the correction was recorded, the receipt agrees.
  const then = reconcileReceiptWithLedger(body, ledger, '2026-08-01T12:00:00.000Z');
  assert.equal(then.status, 'agrees');
});

test('a receipt whose lineage names events this ledger never had is not reconcilable, and a missing source disagrees', () => {
  const ledger = ledgerWith(charge('economic:request:a:charge', '1'));
  const foreign = buildEconomicReceiptBody('deadbeef', 'segreant', 1, null, funnel, economicAttributionView({
    amount: money('1', 'USD', 'effective'), eventIds: ['economic:request:elsewhere:charge'], sourceBases: ['list'], requestCount: 1, unresolvedRequests: 0,
  }));
  const result = reconcileReceiptWithLedger(foreign, ledger);
  assert.equal(result.status, 'not_reconcilable');
  assert.deepEqual(result.missingEventIds, ['economic:request:elsewhere:charge']);

  const partly = buildEconomicReceiptBody('deadbeef', 'segreant', 2, null, funnel, economicAttributionView({
    amount: money('2', 'USD', 'effective'), eventIds: ['economic:request:a:charge', 'economic:request:gone:charge'], sourceBases: ['list'], requestCount: 2, unresolvedRequests: 0,
  }));
  const partial = reconcileReceiptWithLedger(partly, ledger);
  assert.equal(partial.status, 'disagrees');
  assert.deepEqual(partial.missingEventIds, ['economic:request:gone:charge']);
  assert.equal(partial.ledgerAmountText, '1');
});

test('a v1 receipt carries no lineage and says so', () => {
  const ledger = ledgerWith(charge('economic:request:a:charge', '1'));
  const result = reconcileReceiptWithLedger(buildReceiptBody('deadbeef', 'segreant', 1, null, funnel), ledger);
  assert.equal(result.status, 'not_reconcilable');
  assert.match(result.reasons.join(' '), /v1/);
});

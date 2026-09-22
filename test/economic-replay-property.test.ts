import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { economicEvent } from '../src/economics/events.ts';
import { priceCorrectionEvent } from '../src/economics/corrections.ts';
import { formatMoneyAmount, money } from '../src/economics/money.ts';

function at(ms: number): string {
  return new Date(ms).toISOString();
}

function source(id: string) {
  return economicEvent({
    id,
    kind: 'charge_estimated',
    subject: `request:${id}`,
    occurredAt: at(10),
    recordedAt: at(20),
    amount: money('10', 'USD', 'list'),
    sourceEventIds: [],
    reversalOf: null,
    metadata: { requestId: id },
    schemaVersion: 1,
  });
}

function correction(sourceEvent: ReturnType<typeof source>, id: string, recordedAtMs: number) {
  return priceCorrectionEvent({
    id,
    source: sourceEvent,
    previousAmount: money('10', 'USD', 'list'),
    nextAmount: money('12', 'USD', 'list'),
    recordedAt: at(recordedAtMs),
  });
}

function balances(ledger: EconomicLedger, asOf: number) {
  return ledger.project(at(asOf)).balances.map((balance) => ({
    role: balance.role,
    currency: balance.currency,
    basis: balance.basis,
    amount: formatMoneyAmount(balance.amount),
    eventIds: [...balance.eventIds],
  }));
}

test('economic replay permutations preserve immutable closes and recorded-time correction projections', () => {
  const directDb = new DatabaseSync(':memory:');
  const direct = new EconomicLedger(directDb);
  const directSource = source('economic:replay:source');
  direct.append(directSource);
  direct.append(correction(directSource, 'economic:replay:correction', 30));
  const directClose = direct.finalizePeriod({
    id: 'economic:replay:direct:close',
    periodStartMs: 0,
    periodEndMs: 100,
    recordedAt: at(200),
  });

  const reopenedDb = new DatabaseSync(':memory:');
  const reopened = new EconomicLedger(reopenedDb);
  const reopenedSource = source('economic:replay:source');
  reopened.append(reopenedSource);
  const firstClose = reopened.finalizePeriod({
    id: 'economic:replay:reopened:first-close',
    periodStartMs: 0,
    periodEndMs: 100,
    recordedAt: at(200),
  });
  reopened.reopenPeriod({
    id: 'economic:replay:reopened:reopen',
    periodStartMs: 0,
    periodEndMs: 100,
    recordedAt: at(210),
    reason: 'late price correction',
  });
  reopened.append(correction(reopenedSource, 'economic:replay:correction', 220));
  const reopenedClose = reopened.finalizePeriod({
    id: 'economic:replay:reopened:second-close',
    periodStartMs: 0,
    periodEndMs: 100,
    recordedAt: at(230),
  });

  assert.deepEqual(balances(direct, 25), balances(reopened, 205));
  assert.deepEqual(balances(direct, 35), balances(reopened, 225));
  const beforeCorrection = reopened.project(at(205));
  const afterCorrection = reopened.project(at(225));
  assert.equal(formatMoneyAmount(beforeCorrection.balances.find((balance) => balance.role === 'charge')!.amount), '10');
  assert.equal(beforeCorrection.balances.find((balance) => balance.role === 'price'), undefined);
  assert.equal(formatMoneyAmount(afterCorrection.balances.find((balance) => balance.role === 'charge')!.amount), '10');
  assert.equal(formatMoneyAmount(afterCorrection.balances.find((balance) => balance.role === 'price')!.amount), '2');
  assert.equal(formatMoneyAmount(reopened.effectiveChargeFor('economic:replay:source', at(205))!.amount), '10');
  assert.equal(formatMoneyAmount(reopened.effectiveChargeFor('economic:replay:source', at(225))!.amount), '12');
  assert.deepEqual(reopened.effectiveChargeFor('economic:replay:source', at(225))!.eventIds, [
    'economic:replay:source',
    'economic:replay:correction',
  ]);

  assert.equal(directClose.projectionDigest, reopenedClose.projectionDigest);
  assert.equal(directClose.eventCount, reopenedClose.eventCount);
  assert.deepEqual(directClose.sourceEventIds, [
    'economic:replay:correction',
    'economic:replay:source',
  ]);
  assert.deepEqual(reopenedClose.sourceEventIds, [
    'economic:replay:correction',
    'economic:replay:source',
  ]);

  const historicalFirstClose = reopened.read(firstClose.eventId)!;
  assert.equal(historicalFirstClose.kind, 'close_finalized');
  assert.deepEqual(historicalFirstClose.sourceEventIds, ['economic:replay:source']);
  assert.equal(reopened.read(reopenedClose.eventId)!.kind, 'close_finalized');
  assert.notEqual(firstClose.eventId, reopenedClose.eventId);

  directDb.close();
  reopenedDb.close();
});

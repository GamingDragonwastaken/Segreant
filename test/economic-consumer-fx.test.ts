import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { requestEconomicEvent, requestEconomicEventId } from '../src/economics/request.ts';
import { exactRate } from '../src/economics/rate.ts';
import { interval } from '../src/epistemic/time.ts';
import { money, formatMoneyAmount } from '../src/economics/money.ts';
import { effectiveRequestRow } from '../src/store/economicReadModel.ts';
import { buildEconomicRequestExportRows } from '../src/export/economic.ts';

const VALID_TIME = interval('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z');
const REQUEST_ID = 'consumer-fx-request';

function requestRow() {
  return {
    requestId: REQUEST_ID,
    sessionId: 'session:consumer',
    tsEpochMs: Date.parse('2026-08-02T12:00:00.000Z'),
    provider: 'provider-fixture',
    model: 'model-fixture',
    project: 'project-fixture',
    projectCanonical: 'project-fixture',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 10,
    economicAmount: money('10', 'USD', 'list'),
    estimated: true,
    streamed: false,
    statusCode: 200,
    durationMs: 10,
    via: 'proxy' as const,
    user: null,
    source: null,
  };
}

function originalRate() {
  return {
    id: 'fx-rate:consumer:original',
    rate: exactRate({ numerator: 9n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    rateSource: 'fixture:consumer:original',
    recordedAt: '2026-08-01T12:00:00.000Z',
    supersedes: null,
  };
}

function correctedRate() {
  return {
    id: 'fx-rate:consumer:corrected',
    rate: exactRate({ numerator: 8n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    rateSource: 'fixture:consumer:corrected',
    recordedAt: '2026-08-03T12:00:00.000Z',
    supersedes: originalRate().id,
  };
}

function seededLedger() {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  ledger.append(requestEconomicEvent({
    requestId: REQUEST_ID,
    sessionId: 'session:consumer',
    tsEpochMs: requestRow().tsEpochMs,
    provider: requestRow().provider,
    model: requestRow().model,
    project: requestRow().project,
    amount: money('10', 'USD', 'list'),
    via: 'proxy',
    recordedAt: '2026-08-02T12:00:00.000Z',
  }));
  ledger.appendHistoricalRateObservation(originalRate());
  ledger.appendHistoricalRateObservation(correctedRate());
  return { db, ledger };
}

test('read-model FX translation is absent by default and explicit as-of selects persisted rate knowledge', () => {
  const { db, ledger } = seededLedger();
  try {
    const request = requestRow();
    const untranslated = effectiveRequestRow(request, ledger);
    assert.equal(untranslated.fxTranslation, null);

    const beforeSource = effectiveRequestRow(request, ledger, { asOf: '2026-08-01T00:00:00.000Z' });
    assert.equal(beforeSource.effectiveAmount, null);
    assert.equal(beforeSource.unresolvedReason, 'no_exact_economic_event');
    assert.equal(beforeSource.fxTranslation, null);

    const atSourceRecording = effectiveRequestRow(request, ledger, { targetUnit: 'EUR' });
    assert.equal(formatMoneyAmount(atSourceRecording.fxTranslation!.translatedAmount), '9');
    assert.equal(atSourceRecording.fxTranslation!.rateSource, originalRate().rateSource);
    assert.equal(atSourceRecording.fxTranslation!.rateAsOf, '2026-08-02T12:00:00.000Z');

    const afterCorrection = effectiveRequestRow(request, ledger, {
      targetUnit: 'EUR',
      asOf: '2026-08-04T00:00:00.000Z',
    });
    assert.equal(formatMoneyAmount(afterCorrection.fxTranslation!.translatedAmount), '8');
    assert.equal(afterCorrection.fxTranslation!.rateSource, correctedRate().rateSource);
  } finally {
    db.close();
  }
});

test('economic export preserves source, target, rate provenance, and as-of boundary', () => {
  const { db, ledger } = seededLedger();
  try {
    const exported = buildEconomicRequestExportRows([requestRow()], ledger, {
      targetUnit: 'EUR',
      asOf: '2026-08-04T00:00:00.000Z',
    });
    assert.equal(exported.length, 1);
    const row = exported[0]!;
    assert.equal(row.sourceCurrency, 'USD');
    assert.equal(row.effectiveCurrency, 'USD');
    assert.equal(row.translatedCurrency, 'EUR');
    assert.equal(row.translatedAmount, '8');
    assert.equal(row.fxRateSource, correctedRate().rateSource);
    assert.equal(row.fxRateAsOf, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(row.fxRate, {
      numerator: '4',
      denominator: '5',
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: { from: VALID_TIME.from, to: VALID_TIME.to },
    });
  } finally {
    db.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { exactRate, selectHistoricalRate } from '../src/economics/rate.ts';
import { interval } from '../src/epistemic/time.ts';

const VALID_TIME = interval('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z');

function original() {
  return {
    id: 'fx-rate:persistence:original',
    rate: exactRate({ numerator: 9n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    rateSource: 'fixture:persistence:original',
    recordedAt: '2026-08-01T14:00:00.000Z',
    supersedes: null,
  };
}

function correction() {
  return {
    id: 'fx-rate:persistence:correction',
    rate: exactRate({ numerator: 8n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    rateSource: 'fixture:persistence:correction',
    recordedAt: '2026-08-03T14:00:00.000Z',
    supersedes: original().id,
  };
}

test('historical FX observations persist append-only and select by recorded-time as-of', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    assert.equal(ledger.appendHistoricalRateObservation(original()), 'inserted');
    assert.equal(ledger.appendHistoricalRateObservation(original()), 'duplicate');
    assert.throws(() => ledger.appendHistoricalRateObservation({
      ...original(),
      rate: exactRate({ numerator: 91n, denominator: 100n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    }), /different historical rate observation already exists/);

    assert.equal(ledger.appendHistoricalRateObservation(correction()), 'inserted');
    const beforeCorrection = ledger.historicalRateBook('2026-08-02T00:00:00.000Z');
    const afterCorrection = ledger.historicalRateBook('2026-08-04T00:00:00.000Z');
    assert.equal(beforeCorrection.observations.length, 1);
    assert.equal(afterCorrection.observations.length, 2);
    assert.equal(selectHistoricalRate(beforeCorrection, {
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      effectiveAt: '2026-08-02T12:00:00.000Z',
    }).id, original().id);
    assert.equal(selectHistoricalRate(afterCorrection, {
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      effectiveAt: '2026-08-02T12:00:00.000Z',
    }).id, correction().id);

    assert.throws(() => db.prepare(
      'UPDATE economic_fx_rate_observations SET observation_json = observation_json WHERE observation_id = ?',
    ).run(original().id), /append-only/);
    assert.throws(() => db.prepare(
      'DELETE FROM economic_fx_rate_observations WHERE observation_id = ?',
    ).run(original().id), /append-only/);
  } finally {
    db.close();
  }
});

test('historical FX rate persistence fails closed on a direct forged row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new EconomicLedger(db);
    db.prepare(
      `INSERT INTO economic_fx_rate_observations
       (observation_id, recorded_at, supersedes_id, observation_json, observation_digest)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('fx-rate:persistence:forged', '2026-08-01T00:00:00.000Z', null, '{}', 'sha256:forged');
    assert.throws(() => ledger.historicalRateBook(), /digest|JSON|historical rate/i);
  } finally {
    db.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { money } from '../src/economics/money.ts';
import { exactRate } from '../src/economics/rate.ts';
import { interval } from '../src/epistemic/time.ts';

function request(): RequestRow {
  return {
    requestId: 'request:dashboard-economic', sessionId: null, tsEpochMs: 0,
    provider: 'anthropic', model: 'claude-opus-4-8', project: 'fiscus', taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 1, economicAmount: money('1', 'USD', 'list'), estimated: false,
    streamed: false, statusCode: 200, durationMs: 1, via: 'proxy',
  };
}

test('GET /api/economic serves the shared exact report and stays read-only', async () => {
  const store = new Store(':memory:');
  store.insertRequest(request());
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/economic?all=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      kind: string;
      schemaVersion: number;
      window: { requestCoverage: { amount: string; currency: string; basis: string; complete: boolean } };
      projection: { balances: Array<{ role: string; amount: string; currency: string; basis: string }> };
      periodClose: {
        status: string;
        activeFinalizationId: string | null;
        latestFinalizationId: string | null;
        latestReopenId: string | null;
        projectionDigest: string | null;
        eventCount: number | null;
      };
    };
    assert.equal(body.kind, 'economic_projection');
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.window.requestCoverage.amount, '1');
    assert.equal(body.window.requestCoverage.currency, 'USD');
    assert.equal(body.window.requestCoverage.basis, 'effective');
    assert.equal(body.window.requestCoverage.complete, true);
    assert.ok(body.projection.balances.some((balance) => balance.role === 'charge' && balance.amount === '1' && balance.currency === 'USD' && balance.basis === 'list'));
    assert.equal(body.periodClose.status, 'open');
    assert.equal(body.periodClose.activeFinalizationId, null);
    assert.equal(body.periodClose.latestFinalizationId, null);
    assert.equal(body.periodClose.latestReopenId, null);
    assert.equal(body.periodClose.projectionDigest, null);
    assert.equal(body.periodClose.eventCount, null);
    assert.equal(JSON.stringify(body).includes('BigInt'), false);

    const head = await fetch(`http://127.0.0.1:${port}/api/economic?all=1`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const invalid = await fetch(`http://127.0.0.1:${port}/api/economic?days=0`);
    assert.equal(invalid.status, 400);

    const post = await fetch(`http://127.0.0.1:${port}/api/economic`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('GET /api/economic forwards historical target and as-of context into one report', async () => {
  const store = new Store(':memory:');
  store.insertRequest(request());
  store.economic().appendHistoricalRateObservation({
    id: 'fx-rate:dashboard:economic-route',
    rate: exactRate({
      numerator: 4n,
      denominator: 5n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: interval('1969-12-31T00:00:00.000Z', '1971-01-01T00:00:00.000Z'),
    }),
    rateSource: 'fixture:dashboard:economic-route',
    recordedAt: '1970-01-01T00:00:01.000Z',
    supersedes: null,
  });
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const asOf = '2027-01-02T00:00:00.000Z';
    const response = await fetch(`http://127.0.0.1:${port}/api/economic?all=1&targetCurrency=EUR&asOf=${encodeURIComponent(asOf)}`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      window: { requestCoverage: { amount: string; currency: string } };
      translation: { amount: string; currency: string; asOf: string | null; rateSources: string[]; complete: boolean } | null;
      projection: { asOf: string | null };
      periodClose: { asOf: string | null };
    };
    assert.equal(body.window.requestCoverage.amount, '1');
    assert.equal(body.window.requestCoverage.currency, 'USD');
    assert.equal(body.translation?.amount, '0.8');
    assert.equal(body.translation?.currency, 'EUR');
    assert.equal(body.translation?.asOf, asOf);
    assert.deepEqual(body.translation?.rateSources, ['fixture:dashboard:economic-route']);
    assert.equal(body.translation?.complete, true);
    assert.equal(body.projection.asOf, asOf);
    assert.equal(body.periodClose.asOf, asOf);

    const invalid = await fetch(`http://127.0.0.1:${port}/api/economic?all=1&targetCurrency=EUR&asOf=not-an-instant`);
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('GET /api/export-csv can opt into persisted historical FX without rewriting source values', async () => {
  const store = new Store(':memory:');
  store.insertRequest(request());
  store.economic().appendHistoricalRateObservation({
    id: 'fx-rate:dashboard:original',
    rate: exactRate({
      numerator: 9n,
      denominator: 10n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: interval('1969-12-31T00:00:00.000Z', '1971-01-01T00:00:00.000Z'),
    }),
    rateSource: 'fixture:dashboard:original',
    recordedAt: '1970-01-01T00:00:01.000Z',
    supersedes: null,
  });
  store.economic().appendHistoricalRateObservation({
    id: 'fx-rate:dashboard:corrected',
    rate: exactRate({
      numerator: 4n,
      denominator: 5n,
      sourceUnit: 'USD',
      targetUnit: 'EUR',
      validTime: interval('1969-12-31T00:00:00.000Z', '1971-01-01T00:00:00.000Z'),
    }),
    rateSource: 'fixture:dashboard:corrected',
    recordedAt: '1970-01-02T00:00:01.000Z',
    supersedes: 'fx-rate:dashboard:original',
  });
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/export.csv?range=all&economic=1&targetCurrency=EUR`);
    assert.equal(response.status, 200);
    const csv = await response.text();
    assert.match(csv, /translatedAmount/);
    assert.match(csv, /translatedCurrency/);
    assert.match(csv, /fixture:dashboard:corrected/);
    assert.match(csv, /,USD,.*,EUR,/);

    const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/export.csv?range=all`);
    assert.equal(legacyResponse.status, 200);
    assert.doesNotMatch(await legacyResponse.text(), /translatedAmount/);

    const invalidAsOf = await fetch(`http://127.0.0.1:${port}/api/export.csv?range=all&economic=1&asOf=not-an-instant`);
    assert.equal(invalidAsOf.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

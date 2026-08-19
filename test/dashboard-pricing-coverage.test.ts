import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Store, type RequestRow } from '../src/store/db.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

function row(): RequestRow {
  return {
    requestId: 'dashboard-pricing-coverage-fixture', sessionId: null, tsEpochMs: Date.now(),
    provider: 'openai', model: 'gpt-5', project: 'fixture', taskWeight: 1,
    inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 1.25, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
    },
  };
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('GET /api/pricing reproduces the immutable pricing --coverage evidence model without mutation or network', async () => {
  const store = new Store(':memory:');
  store.insertRequest(row());
  const srv = await boot(store);
  try {
    const response = await fetch(`${srv.base}/api/pricing?all=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      window: { label: string };
      total: { costUsd: number; requests: number };
      provenance: Array<Record<string, unknown>>;
      boundary: string;
    };
    assert.equal(body.window.label, 'all recorded time');
    assert.deepEqual(body.total, { costUsd: 1.25, requests: 1 });
    assert.deepEqual(body.provenance, [{
      provider: 'openai', model: 'gpt-5', costBasis: 'local_list_price', rateCardSha256: 'c'.repeat(64),
      rateCardSourceKind: 'bundled', rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
      requests: 1, costUsd: 1.25, estimatedCostUsd: 0, inputTokens: 100, outputTokens: 20,
    }]);
    assert.match(body.boundary, /does not fetch pricing, reprice history/i);
    assert.match(body.boundary, /provider-billed or reconciled cost/i);
    assert.equal(store.summary(0, Date.now() + 1000).requests, 1, 'GET coverage must not mutate the ledger');
  } finally {
    await srv.close();
    store.close();
  }
});

test('/api/pricing validates the window and is GET-only', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const invalid = await fetch(`${srv.base}/api/pricing?days=0`);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /positive number/);
    const post = await fetch(`${srv.base}/api/pricing?days=30`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  } finally {
    await srv.close();
    store.close();
  }
});

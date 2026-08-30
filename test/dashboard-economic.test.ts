import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { money } from '../src/economics/money.ts';

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
    };
    assert.equal(body.kind, 'economic_projection');
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.window.requestCoverage.amount, '1');
    assert.equal(body.window.requestCoverage.currency, 'USD');
    assert.equal(body.window.requestCoverage.basis, 'effective');
    assert.equal(body.window.requestCoverage.complete, true);
    assert.ok(body.projection.balances.some((balance) => balance.role === 'charge' && balance.amount === '1' && balance.currency === 'USD' && balance.basis === 'list'));
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

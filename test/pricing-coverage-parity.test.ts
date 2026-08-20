/**
 * `fiscus pricing --coverage` and `GET /api/pricing` must answer the same
 * question with the same numbers.
 *
 * This repository has already paid once for a parity claim maintained by hand:
 * `src/value/report.ts` exists because five comments in the dashboard asserted
 * that its value arithmetic matched the CLI's, and asserting is not enforcing.
 * So the two surfaces here do not have two implementations to compare — they
 * share `pricingCoverage` in src/cost/coverage.ts, and this file proves the
 * route actually composes it rather than reproducing it.
 *
 * The other half of the contract is what the route must NOT do. `--coverage` is
 * a read model over evidence captured at metering time: it cannot fetch a rate
 * card, cannot reprice a historical row, and cannot restate a local list-price
 * estimate as provider-billed cost. A GET that quietly refreshed pricing would
 * change the very answer it was asked to report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { pricingCoverage, PRICING_COVERAGE_BOUNDARY } from '../src/cost/coverage.ts';

function seed(store: Store, now: number): void {
  const rows = [
    { requestId: 'p1', model: 'claude-opus-4-8', provider: 'anthropic', costUsd: 12, ageDays: 1 },
    { requestId: 'p2', model: 'claude-opus-4-8', provider: 'anthropic', costUsd: 3, ageDays: 2 },
    { requestId: 'p3', model: 'gpt-4o-mini', provider: 'openai', costUsd: 0.5, ageDays: 40 },
  ];
  for (const r of rows) {
    store.insertRequest({
      requestId: r.requestId, sessionId: null, tsEpochMs: now - r.ageDays * 24 * 60 * 60 * 1000,
      provider: r.provider, model: r.model, project: 'default', taskWeight: 1,
      inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: r.costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 5,
    });
  }
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function get(base: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/pricing reports exactly what the CLI read model reports', async () => {
  const now = Date.now();
  const store = new Store(':memory:');
  seed(store, now);
  const srv = await boot(store);
  try {
    // The CLI's path, called directly.
    const cli = pricingCoverage(store, { all: false, days: 30, maxAgeDays: DEFAULT_CONFIG.pricing.maxAgeDays }, now);
    const api = await get(srv.base, '/api/pricing?days=30');
    assert.equal(api.status, 200);

    // The 40-day-old row is outside a 30-day window in BOTH, which is what makes
    // this a real comparison rather than two views of the same total.
    assert.equal(cli.total.requests, 2, 'window should exclude the 40-day-old row');
    assert.equal(api.body.total.requests, cli.total.requests);
    assert.equal(api.body.total.costUsd, cli.total.costUsd);
    assert.equal(api.body.window.label, cli.window.label);
    assert.equal(api.body.boundary, PRICING_COVERAGE_BOUNDARY);

    // Compared through JSON on both sides. node:sqlite hands back rows with a
    // null prototype, so a direct deepStrictEqual fails on the prototype alone
    // while every field matches — and what parity means here is that the two
    // surfaces REPORT the same thing, which is the serialized form either way.
    assert.deepEqual(api.body.provenance, JSON.parse(JSON.stringify(cli.provenance)));

    // The route adds exactly two fields of its own and changes nothing else.
    const { demo, generatedAt, ...shared } = api.body;
    assert.equal(typeof demo, 'boolean');
    assert.equal(typeof generatedAt, 'string');
    assert.deepEqual(Object.keys(shared).sort(), Object.keys(cli).sort());
  } finally {
    await srv.close();
    store.close();
  }
});

test('all=1 takes precedence over days, matching the CLI --all flag', async () => {
  const now = Date.now();
  const store = new Store(':memory:');
  seed(store, now);
  const srv = await boot(store);
  try {
    const api = await get(srv.base, '/api/pricing?all=1&days=1');
    assert.equal(api.status, 200);
    assert.equal(api.body.window.label, 'all recorded time');
    assert.equal(api.body.window.startMs, 0);
    assert.equal(api.body.total.requests, 3, 'all recorded time includes the 40-day-old row');
  } finally {
    await srv.close();
    store.close();
  }
});

test('an unusable days window is refused rather than silently defaulted', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    // Quietly substituting 30 would answer a different question than the one
    // asked, over a window the caller never sees.
    for (const q of ['days=0', 'days=-5', 'days=abc']) {
      const api = await get(srv.base, `/api/pricing?${q}`);
      assert.equal(api.status, 400, `?${q} should be refused`);
      assert.match(api.body.error, /positive number/);
    }
  } finally {
    await srv.close();
    store.close();
  }
});

test('the pricing route is a read: it cannot refresh a card or reprice history', async () => {
  const now = Date.now();
  const store = new Store(':memory:');
  seed(store, now);
  const srv = await boot(store);
  try {
    const before = pricingCoverage(store, { all: true, days: 30, maxAgeDays: 30 }, now);
    for (let i = 0; i < 3; i++) await get(srv.base, '/api/pricing?all=1');
    const after = pricingCoverage(store, { all: true, days: 30, maxAgeDays: 30 }, now);

    // Same recorded amounts, same evidence cohorts, same card digests.
    assert.deepEqual(after.provenance, before.provenance);
    assert.equal(after.total.costUsd, before.total.costUsd);
    assert.equal(after.total.requests, before.total.requests);
  } finally {
    await srv.close();
    store.close();
  }
});

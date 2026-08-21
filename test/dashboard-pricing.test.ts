/**
 * Pins the dashboard's pricing-health surface to local evidence only. The
 * Overview can disclose rate-card freshness and estimate coverage, but it must
 * never refresh pricing, alter stored rows, or represent a local price as a
 * provider-billed amount.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `pricing-${Math.random()}`,
    sessionId: null,
    tsEpochMs: Date.now(),
    provider: 'openai',
    model: 'gpt-5',
    project: 'pricing-fixture',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 1,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    ...overrides,
  };
}

function boot(store: Store) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.pricing.autoRefresh = false;
  const server = createDashboardServer({ store, config, version: 'test' });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('GET /api/overview exposes local rate-card freshness and estimated-rate coverage without a pricing refresh', async () => {
  const oldHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-dashboard-pricing-'));
  process.env.FISCUS_HOME = home;
  const store = new Store(':memory:');
  store.insertRequest(request({
    requestId: 'exact', costUsd: 3, estimated: false,
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'a'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
    },
  }));
  store.insertRequest(request({
    requestId: 'estimated', costUsd: 2, estimated: true, model: 'unlisted-model',
    pricing: {
      costBasis: 'fallback_estimate', rateCardSha256: 'a'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'fallback', rateMatchProvider: null, rateMatchModel: null,
    },
  }));
  // The same observed model on a prior card stays a separate cohort. A current
  // card must never collapse or reinterpret historical ledger evidence.
  store.insertRequest(request({
    requestId: 'prior-card', costUsd: 0.5, estimated: false,
    pricing: {
      costBasis: 'local_list_price', rateCardSha256: 'b'.repeat(64), rateCardSourceKind: 'native_manifest',
      rateMatchKind: 'exact_provider', rateMatchProvider: 'openai', rateMatchModel: 'gpt-5',
    },
  }));
  const srv = await boot(store);
  try {
    const response = await fetch(`${srv.base}/api/overview?range=all`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      pricing: {
        autoRefresh: boolean;
        estimatedCostUsd: number;
        estimatedSpendShare: number;
        status: { source: string; cardSha256: string; freshnessBasis: string; modelCount: number };
        provenance: Array<{
          model: string; costBasis: string; rateCardSha256: string | null;
          rateMatchKind: string; requests: number; costUsd: number; estimatedCostUsd: number;
        }>;
      };
      summary: { costUsd: number };
    };
    assert.equal(body.summary.costUsd, 5.5);
    assert.equal(body.pricing.autoRefresh, false);
    assert.equal(body.pricing.estimatedCostUsd, 2);
    assert.equal(body.pricing.estimatedSpendShare, 2 / 5.5);
    assert.equal(body.pricing.status.source, 'bundled', 'isolated home proves the endpoint does not create/refresh a cache');
    assert.match(body.pricing.status.cardSha256, /^[a-f0-9]{64}$/);
    assert.equal(body.pricing.status.freshnessBasis, 'declared_card_date');
    assert.ok(body.pricing.status.modelCount > 0);
    assert.equal(body.pricing.provenance.length, 3);
    assert.deepEqual(body.pricing.provenance.map((row) => [row.model, row.costBasis, row.rateMatchKind, row.requests, row.costUsd, row.estimatedCostUsd]), [
      ['gpt-5', 'local_list_price', 'exact_provider', 1, 3, 0],
      ['unlisted-model', 'fallback_estimate', 'fallback', 1, 2, 2],
      ['gpt-5', 'local_list_price', 'exact_provider', 1, 0.5, 0],
    ]);
    assert.equal(body.pricing.provenance[0]!.rateCardSha256, 'a'.repeat(64));
    assert.equal(body.pricing.provenance[2]!.rateCardSha256, 'b'.repeat(64));

    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
    assert.match(html, /Rate-card health/);
    assert.match(html, /Estimated-rate share/);
    assert.match(html, /this page never fetches pricing/);
    assert.match(html, /fiscus pricing --refresh/);
    assert.match(html, /Recorded basis/);
    assert.match(html, /immutable evidence cohort/);
  } finally {
    await srv.close();
    store.close();
    if (oldHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

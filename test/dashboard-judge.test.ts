/**
 * POST /api/judge — the dashboard's judge trigger (plan Task 4).
 *
 * Properties: judges a REAL session from the store (newest activity in the
 * window by default); returns the honest no-sessions shape on an empty store;
 * POST-only with the same same-origin header guard as the other action routes
 * (a judge call can reach a user-configured endpoint, so a cross-site page
 * must not be able to trigger it); discloses the resolved tier's
 * sendsContentOffDevice bit so the UI can warn before anything leaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: Date.now(), provider: 'anthropic',
    model: 'm', project: 'test-project', taskWeight: 1, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0.01, estimated: false, streamed: false, statusCode: 200,
    durationMs: 100, ...over,
  };
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function postJudge(base: string, body: unknown, headers: Record<string, string> = { 'x-fiscus-local': '1' }): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('POST /api/judge: judges the newest real session algorithmically by default; discloses the tier', async () => {
  const store = new Store(':memory:');
  store.upsertSession('real-session-1', 'test-project', 'proxy', Date.now() - 60_000);
  store.insertRequest(req({ sessionId: 'real-session-1', tsEpochMs: Date.now() - 60_000 }));
  store.insertRequest(req({ sessionId: 'real-session-1', tsEpochMs: Date.now() - 30_000 }));
  const srv = await boot(store);
  try {
    const r = await postJudge(srv.base, { project: 'test-project' });
    assert.equal(r.status, 200);
    const judgment = r.body.judgment as { sessionId: string; confidence: string; efficiencyMultiplier: number };
    assert.equal(judgment.sessionId, 'real-session-1');
    assert.equal(judgment.confidence, 'algorithmic', 'default config → algorithmic, no invented tier');
    assert.ok(Number.isFinite(judgment.efficiencyMultiplier));
    const session = r.body.session as { tool: string; requestCount: number };
    assert.equal(session.tool, 'proxy');
    assert.equal(session.requestCount, 2);
    const tier = r.body.tier as { tier: string; sendsContentOffDevice: boolean };
    assert.equal(tier.tier, 'algorithmic');
    assert.equal(tier.sendsContentOffDevice, false);
  } finally {
    await srv.close();
    store.close();
  }
});

test('POST /api/judge rejects an oversized body before reading or judging it', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fiscus-local': '1' },
      body: JSON.stringify({ project: 'test-project', padding: 'x'.repeat(20 * 1024) }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'DASHBOARD_REQUEST_TOO_LARGE');
  } finally {
    await srv.close();
    store.close();
  }
});

test('POST /api/judge: empty store → honest no-sessions shape; GET → 405; missing local header → 403', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const empty = await postJudge(srv.base, { project: 'test-project' });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.error, 'no-sessions-in-window');

    const get = await fetch(`${srv.base}/api/judge`);
    assert.equal(get.status, 405);

    const noHeader = await fetch(`${srv.base}/api/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'test-project' }),
    });
    assert.equal(noHeader.status, 403, 'cross-site POST without the same-origin header must be rejected');
  } finally {
    await srv.close();
    store.close();
  }
});

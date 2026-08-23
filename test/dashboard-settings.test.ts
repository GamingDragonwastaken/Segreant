/**
 * Settings module (plan Task 7): pure functions (buildSettingsSnapshot,
 * applySettingsPatch) plus the three dashboard routes that wrap them
 * (GET /api/settings, POST /api/settings/update, POST /api/settings/clear-proposals).
 * Route tests follow the same boot()/fetch() pattern as dashboard-judge.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { buildSettingsSnapshot, applySettingsPatch } from '../src/dashboard/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store, type RequestRow } from '../src/store/db.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: Date.now(), provider: 'anthropic',
    model: 'm', project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1, estimated: false, streamed: false, statusCode: 200,
    durationMs: 1, ...over,
  };
}

// --- pure functions ---------------------------------------------------

test('buildSettingsSnapshot reports config, paths, and recent connections', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ provider: 'anthropic', model: 'claude-3' }));
  const snap = buildSettingsSnapshot(store, structuredClone(DEFAULT_CONFIG), '0.1.0');
  assert.equal(snap.version, '0.1.0');
  assert.equal(snap.metadataOnly, false);
  assert.equal(snap.proposalRetentionDays, 30);
  assert.equal(snap.retentionDays, 180);
  assert.equal(snap.egress.mode, 'local_locked');
  assert.deepEqual(snap.egress.rules, []);
  assert.equal(snap.egress.receipts.ok, true);
  assert.match(snap.egress.scope, /Fiscus-process/i);
  assert.equal(snap.connections.length, 1);
  assert.equal(snap.connections[0]!.provider, 'anthropic');
  store.close();
});

test('buildSettingsSnapshot reports no connections when no traffic is in the window', () => {
  const store = new Store(':memory:');
  const snap = buildSettingsSnapshot(store, structuredClone(DEFAULT_CONFIG), '0.1.0');
  assert.deepEqual(snap.connections, []);
  store.close();
});

test('applySettingsPatch updates only the fields provided, never mutating the input', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  const next = applySettingsPatch(base, { metadataOnly: true, budget: { dailyUsd: 25 } });
  assert.equal(next.metadataOnly, true);
  assert.equal(next.budget.dailyUsd, 25);
  assert.equal(next.budget.sessionUsd, base.budget.sessionUsd); // untouched
  assert.equal(base.metadataOnly, false); // original object never mutated
  assert.equal(base.budget.dailyUsd, null);
});

test('applySettingsPatch treats an explicit null budget field as "turn off"', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  const withCap = applySettingsPatch(base, { budget: { dailyUsd: 25 } });
  const turnedOff = applySettingsPatch(withCap, { budget: { dailyUsd: null } });
  assert.equal(turnedOff.budget.dailyUsd, null);
});

test('applySettingsPatch ignores a non-positive retention value rather than accepting a nonsense cutoff', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  const next = applySettingsPatch(base, { proposalRetentionDays: -5 });
  assert.equal(next.proposalRetentionDays, base.proposalRetentionDays);
});

// --- routes -------------------------------------------------------------

function boot(store: Store): Promise<{ base: string; close: () => Promise<void>; readPersisted: () => typeof DEFAULT_CONFIG }> {
  let persisted = structuredClone(DEFAULT_CONFIG);
  const server: http.Server = createDashboardServer({
    store,
    config: structuredClone(DEFAULT_CONFIG),
    version: 'test',
    configPersistence: {
      load: () => structuredClone(persisted),
      save: (next) => { persisted = structuredClone(next); },
    },
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        readPersisted: () => structuredClone(persisted),
      });
    });
  });
}

test('GET /api/settings returns a snapshot; POST is not allowed', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/settings`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.version, 'test');
    assert.equal(body.metadataOnly, false);
    assert.ok(Array.isArray(body.connections));
    assert.deepEqual((body.egress as { mode?: string }).mode, 'local_locked');

    const post = await fetch(`${srv.base}/api/settings`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await srv.close();
    store.close();
  }
});

test('POST /api/settings/update applies a patch, persists it, and requires the local header', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const noHeader = await fetch(`${srv.base}/api/settings/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadataOnly: true }),
    });
    assert.equal(noHeader.status, 403, 'cross-site POST without the same-origin header must be rejected');

    const res = await fetch(`${srv.base}/api/settings/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fiscus-local': '1' },
      body: JSON.stringify({ metadataOnly: true, budget: { dailyUsd: 42 } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { metadataOnly: boolean; budget: { dailyUsd: number | null } };
    assert.equal(body.metadataOnly, true);
    assert.equal(body.budget.dailyUsd, 42);
    const persisted = srv.readPersisted();
    assert.equal(persisted.metadataOnly, true, 'the route must save through its configured persistence boundary');
    assert.equal(persisted.budget.dailyUsd, 42);

    // A follow-up GET on the same running process reflects the update — no restart needed.
    const after = await fetch(`${srv.base}/api/settings`);
    const afterBody = (await after.json()) as { metadataOnly: boolean };
    assert.equal(afterBody.metadataOnly, true);
  } finally {
    await srv.close();
    store.close();
  }
});

test('POST /api/settings/clear-proposals removes stored proposals and requires the local header', async () => {
  const store = new Store(':memory:');
  store.insertProposal({
    proposalId: 'p-1', requestId: 'r-1', sessionId: null, tsEpochMs: Date.now(),
    provider: 'anthropic', model: 'claude-3', project: 'demo', files: [{ path: 'a.ts', addedLines: ['x'] }],
  });
  const srv = await boot(store);
  try {
    const noHeader = await fetch(`${srv.base}/api/settings/clear-proposals`, { method: 'POST' });
    assert.equal(noHeader.status, 403);

    const res = await fetch(`${srv.base}/api/settings/clear-proposals`, { method: 'POST', headers: { 'x-fiscus-local': '1' } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; removed: number };
    assert.equal(body.ok, true);
    assert.equal(body.removed, 1);
    assert.equal(store.proposalsInWindow('demo', 0, Date.now() + 1000).length, 0);
  } finally {
    await srv.close();
    store.close();
  }
});

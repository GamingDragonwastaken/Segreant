/**
 * GET /api/value is served from an in-memory cache keyed on everything the
 * report reads (src/dashboard/value-cache.ts). These tests assert on the
 * computation counter, never on wall-clock time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-value-cache-home-'));
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { valueReadCacheFor } from '../src/dashboard/routes.ts';
import { ValueReadCache, valueCacheKey, VALUE_CACHE_TTL_MS } from '../src/dashboard/value-cache.ts';

const row = (id: string, ts: number): RequestRow => ({
  requestId: id, sessionId: 's', tsEpochMs: ts, provider: 'openai', model: 'gpt-5', project: 'p', taskWeight: 1,
  inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1,
  estimated: false, streamed: false, statusCode: 200, durationMs: 1, via: 'proxy',
});

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A directory that is not a git repository, so the report's git work is trivial. */
function nonGitRepo(): string {
  return mkdtempSync(join(tmpdir(), 'value-cache-repo-'));
}

test('two identical /api/value reads compute once, and the second body is the first, generatedAt included', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/value?repo=${encodeURIComponent(nonGitRepo())}`;
    const first = await (await fetch(url)).json() as Record<string, unknown>;
    const second = await (await fetch(url)).json() as Record<string, unknown>;
    const cache = valueReadCacheFor(store);
    assert.equal(cache.stats.computes, 1, 'the report is computed once');
    assert.equal(cache.stats.hits, 1, 'the repeat read is a hit');
    assert.deepEqual(second, first, 'the cached payload is served unchanged');
    assert.equal(second['generatedAt'], first['generatedAt'], 'generatedAt keeps the original compute time');
  } finally {
    await srv.close();
    store.close();
  }
});

test('appending a request changes the ledger mark, so the next read recomputes', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/value?repo=${encodeURIComponent(nonGitRepo())}`;
    await (await fetch(url)).json();
    const cache = valueReadCacheFor(store);
    assert.equal(cache.stats.computes, 1);
    store.insertRequest(row('cache-mark-1', Date.now() - 60_000));
    await (await fetch(url)).json();
    assert.equal(cache.stats.computes, 2, 'a changed ledger mark is a miss');
  } finally {
    await srv.close();
    store.close();
  }
});

test('an entry older than the TTL recomputes; one younger than it is still served', async () => {
  const store = new Store(':memory:');
  let clockMs = 1_700_000_000_000;
  const cache = valueReadCacheFor(store, { now: () => clockMs });
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/value?repo=${encodeURIComponent(nonGitRepo())}`;
    await (await fetch(url)).json();
    assert.equal(cache.stats.computes, 1);
    clockMs += VALUE_CACHE_TTL_MS - 1;
    await (await fetch(url)).json();
    assert.equal(cache.stats.computes, 1, 'one millisecond inside the TTL is still a hit');
    clockMs += 1;
    await (await fetch(url)).json();
    assert.equal(cache.stats.computes, 2, 'at the TTL the entry expires and the report is computed again');
  } finally {
    await srv.close();
    store.close();
  }
});

test('concurrent identical reads share one in-flight computation', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/value?repo=${encodeURIComponent(nonGitRepo())}`;
    const bodies = await Promise.all([fetch(url), fetch(url), fetch(url)].map(async (p) => (await p).json()));
    const cache = valueReadCacheFor(store);
    assert.equal(cache.stats.computes, 1, 'three simultaneous reads start one computation');
    assert.equal(cache.stats.shared + cache.stats.hits, 2, 'the other two reads joined it or hit the stored entry');
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);
  } finally {
    await srv.close();
    store.close();
  }
});

test('a fresh Store starts with an empty cache', () => {
  const a = new Store(':memory:');
  const b = new Store(':memory:');
  try {
    assert.notEqual(valueReadCacheFor(a), valueReadCacheFor(b));
    assert.equal(valueReadCacheFor(b).stats.computes, 0);
  } finally {
    a.close();
    b.close();
  }
});

test('the cache is bounded: the least recently used entry is evicted first', async () => {
  const cache = new ValueReadCache<string>({ maxEntries: 2, now: () => 0 });
  let computes = 0;
  const make = (v: string) => async () => { computes += 1; return v; };
  await cache.get('a', make('A'));
  await cache.get('b', make('B'));
  await cache.get('a', make('A')); // touch a, so b is now the oldest
  await cache.get('c', make('C')); // evicts b
  assert.equal(cache.size, 2);
  assert.equal(computes, 3);
  await cache.get('a', make('A'));
  assert.equal(computes, 3, 'a is still stored');
  await cache.get('b', make('B'));
  assert.equal(computes, 4, 'b was evicted and is computed again');
});

test('a failed computation is not stored and the next read tries again', async () => {
  const cache = new ValueReadCache<string>({ now: () => 0 });
  await assert.rejects(cache.get('k', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
  assert.equal(cache.stats.computes, 2);
});

test('valueCacheKey: query parameter order does not matter; a config or HEAD change does', () => {
  const marks = { requests: { rowid: 1, count: 1 } };
  const base = { repo: '/r', head: 'abc', config: { lift: { x: 1 } }, marks };
  const k1 = valueCacheKey({ ...base, params: new URLSearchParams('window=14&repo=/r') });
  const k2 = valueCacheKey({ ...base, params: new URLSearchParams('repo=/r&window=14') });
  assert.equal(k1, k2);
  assert.notEqual(k1, valueCacheKey({ ...base, params: new URLSearchParams('window=7&repo=/r') }));
  assert.notEqual(k1, valueCacheKey({ ...base, head: 'def', params: new URLSearchParams('window=14&repo=/r') }));
  assert.notEqual(k1, valueCacheKey({ ...base, config: { lift: { x: 2 } }, params: new URLSearchParams('window=14&repo=/r') }));
  assert.notEqual(k1, valueCacheKey({ ...base, marks: { requests: { rowid: 2, count: 2 } }, params: new URLSearchParams('window=14&repo=/r') }));
});

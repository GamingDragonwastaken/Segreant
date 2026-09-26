/**
 * The budget guard asks for the day's exact spend on every proxied request.
 * Re-projecting the whole day each time made request N cost O(N) (548 ms of
 * added delay after 2,100 requests in a load test). The day projection is now
 * extended incrementally; these tests hold it equal to a full re-projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store, type ExactSpendProjection, type RequestRow } from '../src/store/db.ts';
import { money, moneyToJson } from '../src/economics/money.ts';

const DAY_START = Date.parse('2026-07-01T00:00:00Z');
const DAY_END = DAY_START + 24 * 60 * 60 * 1000;

function row(i: number, via: 'proxy' | 'import' = 'proxy'): RequestRow {
  const amount = `0.0${10 + (i % 7)}`;
  return {
    requestId: `req_${via}_${i}`, sessionId: null, tsEpochMs: DAY_START + 1000 * i, provider: 'anthropic',
    model: 'claude-sonnet-4-6', project: 'p', taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: Number(amount), economicAmount: money(amount, 'USD', 'list'),
    estimated: false, streamed: false, statusCode: 200, durationMs: 1, user: null, source: 'test', cwd: null, via,
  } as RequestRow;
}

function shape(p: ExactSpendProjection): unknown {
  return { amount: moneyToJson(p.amount), eventIds: [...p.eventIds], sourceBases: [...p.sourceBases], requestCount: p.requestCount, unresolved: p.unresolvedRequests };
}

function full(store: Store, liveOnly: boolean): ExactSpendProjection {
  return (store as unknown as { exactSpendBetweenFull(a: number, b: number, c: boolean): ExactSpendProjection })
    .exactSpendBetweenFull(DAY_START, DAY_END, liveOnly);
}

test('the incrementally extended day projection equals a full re-projection', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-inc-')), 'test.db'));
  for (let i = 0; i < 40; i++) store.insertRequest(row(i));
  for (const liveOnly of [true, false]) store.exactSpendBetween(DAY_START, DAY_END, liveOnly); // prime the cache
  for (let i = 40; i < 90; i++) store.insertRequest(row(i));
  for (let i = 0; i < 15; i++) store.insertRequestIfNew(row(i, 'import'));
  for (const liveOnly of [true, false]) {
    assert.deepEqual(shape(store.exactSpendBetween(DAY_START, DAY_END, liveOnly)), shape(full(store, liveOnly)), `liveOnly=${liveOnly}`);
  }
  assert.equal(store.exactSpendBetween(DAY_START, DAY_END, true).requestCount, 90, 'live-only excludes the imported rows');
  assert.equal(store.exactSpendBetween(DAY_START, DAY_END, false).requestCount, 105);
  store.close();
});

test('removing rows voids the cache instead of serving a stale total', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-del-')), 'test.db'));
  for (let i = 0; i < 20; i++) store.insertRequest(row(i));
  const before = store.exactSpendBetween(DAY_START, DAY_END, true);
  const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  db.prepare("DELETE FROM requests WHERE request_id = 'req_proxy_3'").run();
  store.insertRequest(row(20)); // one append after the removal: counts no longer line up
  const after = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.deepEqual(shape(after), shape(full(store, true)));
  assert.equal(after.requestCount, before.requestCount, 'one removed, one added');
  store.close();
});

test('recording spend no longer slows down as the day fills up', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-perf-')), 'test.db'));
  const timeBatch = (from: number, n: number): number => {
    const t0 = performance.now();
    for (let i = from; i < from + n; i++) {
      store.insertRequest(row(i));
      store.exactSpendBetween(DAY_START, DAY_END, true);
    }
    return (performance.now() - t0) / n;
  };
  timeBatch(0, 50); // warm-up
  const early = timeBatch(50, 100);
  for (let i = 150; i < 1500; i++) store.insertRequest(row(i));
  store.exactSpendBetween(DAY_START, DAY_END, true);
  const late = timeBatch(1500, 100);
  // Before the fix, late/early grew with the ledger (~10x at this size). Allow noise.
  assert.ok(late < early * 3 + 2, `per-request cost grew from ${early.toFixed(2)} ms to ${late.toFixed(2)} ms`);
  store.close();
});

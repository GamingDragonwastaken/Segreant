/**
 * The budget guard asks for the day's exact spend on every proxied request.
 * Re-projecting the whole day each time made request N cost O(N) (548 ms of
 * added delay after 2,100 requests in a load test). The day projection is now
 * extended incrementally, and so is each session's; these tests hold both
 * equal to a full re-projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

function fullSession(store: Store, session: string, liveOnly: boolean): ExactSpendProjection {
  return (store as unknown as { exactSpendForSessionFull(s: string, l: boolean): ExactSpendProjection })
    .exactSpendForSessionFull(session, liveOnly);
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

test('rows removed by another connection void the cache at once', () => {
  // A prune from the CLI while the proxy runs: the deleting connection is not
  // the proxy's, and PRAGMA data_version tells the proxy's connection so.
  const path = join(mkdtempSync(join(tmpdir(), 'exact-del-')), 'test.db');
  const store = new Store(path);
  for (let i = 0; i < 20; i++) store.insertRequest(row(i));
  const before = store.exactSpendBetween(DAY_START, DAY_END, true);
  const other = new DatabaseSync(path);
  other.prepare("DELETE FROM requests WHERE request_id = 'req_proxy_3'").run();
  other.close();
  store.insertRequest(row(20)); // one append after the removal: counts no longer line up
  const after = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.deepEqual(shape(after), shape(full(store, true)));
  assert.equal(after.requestCount, before.requestCount, 'one removed, one added');
  store.close();
});

test('prune voids the cache at once', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-prune-')), 'test.db'));
  for (let i = 0; i < 30; i++) store.insertRequest(row(i));
  const before = store.exactSpendBetween(DAY_START, DAY_END, true);
  store.prune(DAY_START + 1000 * 10); // removes req 0..9
  store.insertRequest(row(30));
  const after = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.deepEqual(shape(after), shape(full(store, true)));
  assert.equal(after.requestCount, before.requestCount - 10 + 1);
  store.close();
});

test('the incrementally extended session projection equals a full re-projection', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-sess-')), 'test.db'));
  const inSession = (i: number, session: string, via: 'proxy' | 'import' = 'proxy') => ({ ...row(i, via), sessionId: session });
  for (let i = 0; i < 30; i++) store.insertRequest(inSession(i, i % 3 === 0 ? 'other' : 'mine'));
  for (const liveOnly of [true, false]) store.exactSpendForSession('mine', liveOnly); // prime
  for (let i = 30; i < 70; i++) store.insertRequest(inSession(i, i % 3 === 0 ? 'other' : 'mine'));
  for (let i = 0; i < 12; i++) store.insertRequestIfNew(inSession(i, 'mine', 'import'));
  for (const session of ['mine', 'other']) {
    for (const liveOnly of [true, false]) {
      assert.deepEqual(shape(store.exactSpendForSession(session, liveOnly)), shape(fullSession(store, session, liveOnly)), `${session} liveOnly=${liveOnly}`);
    }
  }
  assert.equal(store.exactSpendForSession('mine', true).requestCount, 46, 'live-only excludes the imported rows');
  assert.equal(store.exactSpendForSession('mine', false).requestCount, 58);
  store.close();
});

test('recording spend no longer slows down as the day or session fills up', () => {
  // Wall-clock on a shared CI runner is noisy, so each figure is the median of
  // several batches, and the ledger grows by 5,000 rows between the early and
  // late measurements: the O(n) bug this guards made the late figure tens of
  // times the early one at that size, far outside any noise band allowed here.
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-perf-')), 'test.db'));
  let next = 0;
  const batch = (n: number): number => {
    const t0 = performance.now();
    for (let k = 0; k < n; k++) {
      store.insertRequest({ ...row(next++), sessionId: 'perf' });
      store.exactSpendBetween(DAY_START, DAY_END, true);
      store.exactSpendForSession('perf', true);
    }
    return (performance.now() - t0) / n;
  };
  const median = (): number => {
    const runs = Array.from({ length: 7 }, () => batch(20)).sort((a, b) => a - b);
    return runs[3]!;
  };
  batch(50); // warm-up
  const early = median();
  for (let k = 0; k < 5000; k++) store.insertRequest({ ...row(next++), sessionId: 'perf' });
  store.exactSpendBetween(DAY_START, DAY_END, true);
  store.exactSpendForSession('perf', true);
  const late = median();
  assert.ok(late < early * 4 + 3, `per-request cost grew from ${early.toFixed(2)} ms to ${late.toFixed(2)} ms`);
  store.close();
});

/**
 * The budget guard asks for the day's exact spend on every proxied request.
 * Re-projecting the whole day each time made request N cost O(N) (548 ms of
 * added delay after 2,100 requests in a load test). The day projection is now
 * extended incrementally, and so is each session's; these tests hold both
 * equal to a full re-projection.
 *
 * Cost is asserted as work counted by the store (full re-projections and rows
 * an extension reads), not as wall-clock time, so a slow CI runner cannot fail
 * it and a real regression to full re-projection cannot pass it.
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
/** Fixed clock for the cache's expiry window; the store reads Date.now() for it. */
const FROZEN_NOW = Date.parse('2026-07-01T12:00:00Z');
/** Mirrors FULL_REPROJECT_MS in src/store/db.ts: a cached figure this old is rebuilt in full. */
const FULL_REPROJECT_MS = 10 * 60 * 1000;

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
  store.resetExactSpendWorkCounters();
  const after = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.equal(store.exactSpendWorkCounters().fullProjections, 1, 'removal forces a full re-projection');
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
  store.resetExactSpendWorkCounters();
  const after = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.equal(store.exactSpendWorkCounters().fullProjections, 1, 'prune forces a full re-projection');
  assert.deepEqual(shape(after), shape(full(store, true)));
  assert.equal(after.requestCount, before.requestCount - 10 + 1);
  store.close();
});

test('the cached figure is rebuilt in full once it reaches the re-projection interval', (t) => {
  let now = FROZEN_NOW;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-expiry-')), 'test.db'));
  for (let i = 0; i < 30; i++) store.insertRequest(row(i));
  store.exactSpendBetween(DAY_START, DAY_END, true); // full projection, stamped at FROZEN_NOW

  now = FROZEN_NOW + FULL_REPROJECT_MS - 1;
  store.insertRequest(row(30));
  store.resetExactSpendWorkCounters();
  const justBefore = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.equal(store.exactSpendWorkCounters().fullProjections, 0, 'inside the window the append is extended');
  assert.deepEqual(shape(justBefore), shape(full(store, true)));

  now = FROZEN_NOW + FULL_REPROJECT_MS; // extension keeps the original full stamp, so this is due
  store.insertRequest(row(31));
  store.resetExactSpendWorkCounters();
  const due = store.exactSpendBetween(DAY_START, DAY_END, true);
  assert.equal(store.exactSpendWorkCounters().fullProjections, 1, 'at the interval the figure is rebuilt in full');
  assert.deepEqual(shape(due), shape(full(store, true)));
  assert.equal(due.requestCount, 32);
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

test('appended charges extend the cached day and session projections with no full re-projection', (t) => {
  t.mock.method(Date, 'now', () => FROZEN_NOW); // no expiry during the run
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'exact-work-')), 'test.db'));
  const inSession = (i: number) => ({ ...row(i), sessionId: 'mine' });
  for (let i = 0; i < 20; i++) store.insertRequest(inSession(i));
  for (const liveOnly of [true, false]) {
    store.exactSpendBetween(DAY_START, DAY_END, liveOnly); // prime the day
    store.exactSpendForSession('mine', liveOnly); // prime the session
  }

  const BATCH = 50;
  let next = 20;
  for (let batch = 0; batch < 4; batch++) {
    for (let k = 0; k < BATCH; k++) store.insertRequest(inSession(next++));
    store.resetExactSpendWorkCounters();
    const reads: ExactSpendProjection[] = [];
    for (const liveOnly of [true, false]) {
      reads.push(store.exactSpendBetween(DAY_START, DAY_END, liveOnly));
      reads.push(store.exactSpendForSession('mine', liveOnly));
    }
    // Snapshot before the reference projections below, which are full runs too.
    const work = store.exactSpendWorkCounters();
    assert.equal(work.fullProjections, 0, `batch ${batch}: no full re-projection`);
    // Four cache keys (day and session, each live and all). Each extension reads
    // the BATCH new request ids, the BATCH new request rows, and the BATCH new
    // charge events (one charge per ordinary request). Nothing older is read.
    assert.equal(work.incrementalRowsVisited, 4 * 3 * BATCH, `batch ${batch}: rows read by extensions`);

    // Checkpoint: each incremental figure equals its full projection.
    const [dayLive, sessLive, dayAll, sessAll] = reads as [ExactSpendProjection, ExactSpendProjection, ExactSpendProjection, ExactSpendProjection];
    assert.deepEqual(shape(dayLive), shape(full(store, true)), `batch ${batch}: day live`);
    assert.deepEqual(shape(sessLive), shape(fullSession(store, 'mine', true)), `batch ${batch}: session live`);
    assert.deepEqual(shape(dayAll), shape(full(store, false)), `batch ${batch}: day all`);
    assert.deepEqual(shape(sessAll), shape(fullSession(store, 'mine', false)), `batch ${batch}: session all`);
    assert.equal(dayLive.requestCount, 20 + BATCH * (batch + 1));
  }
  store.close();
});

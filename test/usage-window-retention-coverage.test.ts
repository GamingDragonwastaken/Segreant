/**
 * `fiscus usage` told an operator to do the thing they had already done.
 *
 * THE COUNTEREXAMPLE, MEASURED FIRST. Two requests tagged with a session id,
 * sixty days old. `computeUsageRoI` over a ninety-day window returned one unit
 * and $2.00. `fiscus prune` then deleted them on the operator's own retention
 * policy, and the same call over the same window returned zero units and $0.00
 * — at which point `fiscus usage --days 90` prints:
 *
 *     No sessions without code signals in range.
 *     Tag sessions with X-Fiscus-Session-Id to measure them.
 *
 * The first sentence is a claim about the world that is false, and the second
 * is an INSTRUCTION to do what the operator already did and Fiscus already
 * measured. This is D-170's defect with an errand attached: the metering step
 * there was marked NOT DONE for someone who had done it, and here the surface
 * goes further and tells them how to start.
 *
 * WHY THE WINDOW CAN REACH BEHIND THE BOUNDARY. `--days` is the operator's, and
 * `valueReport` passes its own spend window through the same function. Nothing
 * bounds either to the retention policy, and retention is configurable — so the
 * rule cannot be "the default cannot reach it", which is a rule that breaks
 * silently when the person it protects changes the default.
 *
 * WHAT THE FIX IS NOT. It is not "stop saying the list is empty": the list IS
 * empty, and the surviving evidence is reported unchanged. It is that an
 * emptiness produced by DELETION must be distinguishable from an emptiness
 * produced by nothing having happened, and only the second licenses the errand.
 * The figures do not move; a sentence appears beside them.
 *
 * THREE STATES, NOT TWO (D-170). A window entirely inside the retained period
 * says nothing extra. A ledger with NO prune on record says nothing extra
 * either, and that is a different state — unknown, not "nothing was pruned" —
 * which is why `retention` carries `prunedBeforeMs` beside `truncated` rather
 * than a boolean alone. Two tests below hold that both silences stay silent,
 * because a disclosure printed on every run is noise and noise stops being
 * read.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the dashboard discloses it: `/api/value`
 * assembles its own payload and does not carry this field, so the GUI is still
 * silent and that remains open. Nor that `fiscus team push` is covered — a
 * rollup built over a truncated window understates a SHARED total and its
 * receiver cannot tell, which is a bigger finding on a signed protocol and is
 * not made here. Nor anything about traffic that never reached Fiscus, which is
 * the separate and permanent limit of a local meter.
 *
 * Recorded at D-174.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-usage-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { computeUsageRoI } from '../src/value/usage.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'fiscus.mjs');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function runCli(args: string[], db: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: db, FISCUS_HOME: home, NODE_OPTIONS: '' }, timeout: 180_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function tagged(id: string, sessionId: string, tsEpochMs: number): RequestRow {
  return {
    requestId: id, sessionId, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project: 'p', taskWeight: 1, inputTokens: 100, outputTokens: 100, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1, estimated: false, streamed: false,
    statusCode: 200, durationMs: 10,
  };
}

/** A session sixty days back, then a prune that removes it. */
function prunedSession(store: Store): number {
  store.insertRequest(tagged('a', 'sess-old', NOW - 60 * DAY));
  store.insertRequest(tagged('b', 'sess-old', NOW - 60 * DAY + 1_000));
  const boundary = NOW - 30 * DAY;
  assert.equal(store.prune(boundary), 2, 'the fixture must actually lose the session');
  return boundary;
}

const window90 = { startMs: NOW - 90 * DAY, endMs: NOW + 1_000 };

test('a usage window reaching behind the retention boundary reports that it was truncated', () => {
  const store = new Store(':memory:');
  try {
    const before = computeUsageRoI(store, window90);
    assert.equal(before.retention.truncated, false, 'nothing is deleted yet');
    assert.equal(before.retention.prunedBeforeMs, null, 'and no prune is on record, which is a third state');

    const boundary = prunedSession(store);
    const after = computeUsageRoI(store, window90);
    assert.equal(after.units.length, 0, 'the surviving ledger really is empty over this window');
    assert.equal(after.retention.truncated, true);
    assert.equal(after.retention.prunedBeforeMs, boundary);
    assert.equal(after.retention.rowsRemoved, 2);
  } finally {
    store.close();
  }
});

test('the disclosure is additive: the figures it sits beside do not move', () => {
  // The fix must not become a second way to change what is reported. Only the
  // surviving evidence is ever counted, before and after.
  const store = new Store(':memory:');
  try {
    prunedSession(store);
    store.insertRequest(tagged('c', 'sess-new', NOW - 2 * DAY));
    store.insertRequest(tagged('d', 'sess-new', NOW - 2 * DAY + 1_000));
    const report = computeUsageRoI(store, window90);
    assert.equal(report.units.length, 1, 'exactly the surviving session');
    assert.equal(report.totalCostUsd, 2);
    assert.equal(report.retention.truncated, true, 'and it still says the window lost rows');
  } finally {
    store.close();
  }
});

test('a window entirely inside the retained period says nothing extra', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(tagged('a', 'sess', NOW - 2 * DAY));
    assert.equal(store.prune(NOW - 30 * DAY), 0);
    // Ninety days back is before the boundary, so this window IS truncated; the
    // untruncated case is the shorter window an operator asks for by default.
    const short = computeUsageRoI(store, { startMs: NOW - 7 * DAY, endMs: NOW + 1_000 });
    assert.equal(short.retention.truncated, false, 'a window starting after the boundary lost nothing');
    assert.equal(short.retention.prunedBeforeMs, NOW - 30 * DAY, 'the boundary still travels, so a caller can tell the states apart');
  } finally {
    store.close();
  }
});

test('an empty usage report over a truncated window does not send the operator to tag what they tagged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-usage-cli-'));
  const db = join(dir, 'fiscus.db');
  try {
    const store = new Store(db);
    prunedSession(store);
    store.close();

    const result = await runCli(['usage', '--days', '90'], db, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /Tag sessions with X-Fiscus-Session-Id/,
      'the errand is only honest when the emptiness was not produced by a deletion',
    );
    assert.match(result.stdout, /retention|deleted/i, 'and the reason the window is empty must be stated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty usage report over an intact window keeps the instruction that helps', async () => {
  // The guard against fixing this by deleting the sentence. On a ledger with
  // nothing in it and no prune on record, the errand is exactly right.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-usage-cli-clean-'));
  const db = join(dir, 'fiscus.db');
  try {
    new Store(db).close();
    const result = await runCli(['usage', '--days', '90'], db, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Tag sessions with X-Fiscus-Session-Id/);
    assert.doesNotMatch(result.stdout, /retention|deleted by/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-empty usage report over a truncated window discloses beside its figures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-usage-cli-partial-'));
  const db = join(dir, 'fiscus.db');
  try {
    const store = new Store(db);
    prunedSession(store);
    store.insertRequest(tagged('c', 'sess-new', NOW - 2 * DAY));
    store.insertRequest(tagged('d', 'sess-new', NOW - 2 * DAY + 1_000));
    store.close();

    const result = await runCli(['usage', '--days', '90', '--json'], db, dir);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      units: unknown[];
      retention?: { truncated: boolean; prunedBeforeMs: number | null };
    };
    assert.equal(payload.units.length, 1);
    assert.ok(payload.retention, 'the JSON surface must carry the coverage, not only the human one');
    assert.equal(payload.retention.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

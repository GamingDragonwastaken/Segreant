/**
 * Window totals were printed over a range the ledger no longer covers.
 *
 * D-170 recorded the retention boundary and taught `fiscus guide` to read it,
 * because that is the one surface that turns a count into a claim about whether
 * something ever happened. It left the window surfaces untouched and said so.
 * This is that remainder for the three that can reach behind the boundary.
 *
 * WHICH SURFACES, AND WHY THESE THREE. `fiscus sources --all` sets its window
 * start to 0 and prints the words "all time". `fiscus export --all` does the
 * same and emits every surviving row as CSV or JSON. `fiscus export --days N`
 * accepts up to 3650 days. `fiscus today/week/month` are bounded to a month, so
 * the default 180-day retention cannot reach them — but retention is operator
 * configurable and nothing stops a seven-day policy, so the disclosure is on
 * the shared window path rather than on the commands that happen to be long
 * today.
 *
 * TRUNCATION IS A COMPARISON, NOT A FLAG ON THE LEDGER. A window is truncated
 * when a boundary is on record AND the window starts strictly before it. A
 * window starting exactly at the boundary is intact: `prune` deletes rows
 * strictly older than the boundary, so the boundary instant itself survived.
 * Getting that edge wrong in the safe direction would put a warning on every
 * report forever, which is how a disclosure becomes noise and stops being read.
 *
 * NOT TRUNCATED IS NOT THE SAME AS COMPLETE. With no boundary on record,
 * `truncated` is false and `prunedBeforeMs` is null, and the second field is
 * the one that carries the meaning: no prune is ON RECORD. A ledger pruned
 * before `retention_prunes` existed reports exactly this, and inferring a
 * boundary from the oldest surviving row would be the provenance invention this
 * project's second hard rule forbids. So callers get both fields and the CLI
 * says nothing extra in that state rather than asserting coverage it has not
 * got.
 *
 * THE EXPORT NOTICE GOES TO STDERR, AND THAT IS LOAD-BEARING. `fiscus export`
 * writes CSV or JSON to stdout for a pipe or a redirect. A disclosure line on
 * stdout would corrupt every consumer of it — the fix would break the thing it
 * was protecting. It goes where `--out`'s own confirmation already goes, and
 * the test below parses stdout to prove the data stream stayed clean.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the dashboard discloses truncation:
 * `/api/overview` and the browser views still read window summaries with no
 * coverage field, which is a payload-contract change and is not made here. Nor
 * that a window INSIDE the retained period is complete for any other reason —
 * this is about deletion only, and says nothing about traffic that never
 * reached Fiscus, which is the separate and permanent limit of a local meter.
 *
 * Recorded at D-171.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'fiscus.mjs');
const DAY = 24 * 60 * 60 * 1000;

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

function requestAt(id: string, tsEpochMs: number) {
  return {
    requestId: id,
    sessionId: null,
    tsEpochMs,
    provider: 'anthropic',
    model: 'claude-test',
    project: 'retention-window',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.25,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
  };
}

/** Three requests, then a prune that removes the two older ones. */
function prunedStore(db: string, now: number): { boundary: number; removed: number } {
  const store = new Store(db);
  try {
    store.insertRequest(requestAt('old-1', now - 90 * DAY));
    store.insertRequest(requestAt('old-2', now - 60 * DAY));
    store.insertRequest(requestAt('recent', now - 1 * DAY));
    const boundary = now - 30 * DAY;
    const removed = store.prune(boundary);
    assert.equal(removed, 2, 'the fixture must actually lose rows');
    return { boundary, removed };
  } finally {
    store.close();
  }
}

test('a window is truncated only when it starts strictly before a recorded boundary', () => {
  const now = Date.now();
  const store = new Store(':memory:');
  try {
    store.insertRequest(requestAt('old', now - 90 * DAY));
    store.insertRequest(requestAt('recent', now - 1 * DAY));
    const boundary = now - 30 * DAY;
    store.prune(boundary);

    assert.equal(store.windowCoverage(0).truncated, true, 'an all-time window reaches behind the boundary');
    assert.equal(store.windowCoverage(boundary - 1).truncated, true);
    // The boundary instant itself survived: prune deletes rows strictly older.
    assert.equal(store.windowCoverage(boundary).truncated, false, 'the boundary instant is retained, so a window starting there is intact');
    assert.equal(store.windowCoverage(boundary + 1).truncated, false);
  } finally {
    store.close();
  }
});

test('with no boundary on record a window is not truncated and not thereby complete', () => {
  // The two fields say different things and both travel. `truncated: false`
  // alone would read as coverage; the null is what says no prune is ON RECORD.
  const store = new Store(':memory:');
  try {
    const coverage = store.windowCoverage(0);
    assert.equal(coverage.truncated, false);
    assert.equal(coverage.prunedBeforeMs, null, 'no prune on record is a distinct state and must be reported as one');
    assert.equal(coverage.rowsRemoved, 0);
  } finally {
    store.close();
  }
});

test('the coverage a truncated window reports names the boundary and what was removed', () => {
  const now = Date.now();
  const store = new Store(':memory:');
  try {
    store.insertRequest(requestAt('old', now - 90 * DAY));
    const boundary = now - 30 * DAY;
    assert.equal(store.prune(boundary), 1);
    const coverage = store.windowCoverage(0);
    assert.equal(coverage.truncated, true);
    assert.equal(coverage.prunedBeforeMs, boundary);
    assert.equal(coverage.rowsRemoved, 1);
  } finally {
    store.close();
  }
});

test('fiscus sources --all does not call a truncated window all time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-window-sources-'));
  const db = join(dir, 'fiscus.db');
  try {
    const { boundary } = prunedStore(db, Date.now());
    const result = await runCli(['sources', '--all', '--json'], db, dir);
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout) as { window: string; retention?: { truncated: boolean; prunedBeforeMs: number | null } };
    assert.ok(payload.retention, 'the sources payload must carry its retention coverage');
    assert.equal(payload.retention.truncated, true);
    assert.equal(payload.retention.prunedBeforeMs, boundary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fiscus export --all discloses truncation without putting it in the data stream', async () => {
  // The load-bearing half is the second assertion: a warning printed onto
  // stdout would corrupt every consumer of the export it was protecting.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-window-export-'));
  const db = join(dir, 'fiscus.db');
  try {
    prunedStore(db, Date.now());
    const result = await runCli(['export', '--all', '--json'], db, dir);
    assert.equal(result.code, 0, result.stderr);

    const rows = JSON.parse(result.stdout) as unknown[];
    assert.ok(Array.isArray(rows), 'stdout must remain exactly the exported data');
    assert.equal(rows.length, 1, 'one request survived the prune');
    assert.match(result.stderr, /retention|deleted|prun/i, 'the truncation must be disclosed somewhere');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an untruncated export says nothing extra on either stream', async () => {
  // A disclosure that appears on every run is noise and stops being read. This
  // is the case that keeps the edge honest rather than defaulting to a warning.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-window-clean-'));
  const db = join(dir, 'fiscus.db');
  try {
    const store = new Store(db);
    store.insertRequest(requestAt('recent', Date.now() - DAY));
    store.close();

    const result = await runCli(['export', '--all', '--json'], db, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as unknown[]).length, 1);
    assert.doesNotMatch(result.stderr, /retention|deleted by/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

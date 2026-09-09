/**
 * The dashboard could not read what the CLI had been told since D-176.
 *
 * D-176 put two counts on the realization rollup — mature units whose spend
 * window retention truncated, and units whose coverage is unknown — and wired
 * them into `noteSource`, so `fiscus roi` and `fiscus saved` say that the cost
 * totals they print are understated by an unknown amount. D-177 added two more
 * on each model-switch recommendation.
 *
 * `/api/value` sends `rep.matured` whole, so all of that has been on the wire
 * from the moment it existed. None of it was DECLARED. `Matured` in
 * `shared-types.ts` lists the fields the GUI may rely on, and an undeclared
 * field is one a screen cannot read without a cast — which is exactly how
 * `reconciliation.runs` came to be declared a number while the server sent an
 * array, and the Billed band could never light up.
 *
 * **A fact that reaches the wire and no consumer can read is the second
 * recurring class of this program — a mechanism built and never wired — and
 * this instance was created by the fix for the first.** It was named as open in
 * `ACTIVE-EXECUTION.md` at D-175 and is closed here.
 *
 * WHAT THIS TEST DOES. Boots the real dashboard server against a store whose
 * request rows were pruned from inside a real repository's commit attribution
 * window, and asserts the payload carries the counts. `?repo=` points at the
 * temporary repository rather than the launch directory, so the test never
 * mines this checkout's own history.
 *
 * WHAT IT DOES NOT ESTABLISH. That the browser renders them well — the
 * rendering is held by the browser typecheck and by `views/value.ts` reading
 * the declared fields, not by this file. Nor that every other undeclared field
 * on this payload is declared: `usage` is still sent whole and still absent
 * from `ValuePayload`, and that remains open.
 *
 * Recorded at D-178.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-value-retention-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { projectName } from '../src/git/correlate.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const COMMIT_MS = NOW - 60 * DAY;

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-value-repo-'));
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: env ?? process.env });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Fiscus test']);
  writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
  git(['add', '.']);
  const when = new Date(COMMIT_MS).toISOString();
  git(['commit', '-qm', 'feat: work that cost money', '--date', when], {
    ...process.env,
    GIT_COMMITTER_DATE: when,
  });
  return repo;
}

function request(id: string, project: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
    statusCode: 200, durationMs: 1,
  };
}

interface ValueShape {
  realization?: {
    matured?: {
      units?: number;
      spendWindowTruncatedUnits?: number;
      spendWindowUnknownUnits?: number;
    } | null;
  } | null;
}

test('the value payload declares the retention counts the CLI already prints', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  let srv: { base: string; close: () => Promise<void> } | null = null;
  try {
    const project = await projectName(repo);
    store.insertRequest(request('in-window', project, COMMIT_MS - HOUR, 6));
    store.prune(NOW - 30 * DAY);

    srv = await boot(store);
    const res = await fetch(`${srv.base}/api/value?repo=${encodeURIComponent(repo)}`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as ValueShape;

    const matured = payload.realization?.matured ?? null;
    assert.ok(matured, 'the payload must carry a realization slice for this repository');
    // Present rather than absent is the whole assertion: `undefined` here is a
    // field the browser cannot read, which is how a fact reaches the wire and
    // no screen can act on it.
    assert.equal(typeof matured.spendWindowTruncatedUnits, 'number', 'the truncated count must be on the wire and declared');
    assert.equal(typeof matured.spendWindowUnknownUnits, 'number', 'and so must the unknown count, which is a different state');
  } finally {
    await srv?.close();
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an intact ledger reports zero on both counts rather than omitting them', async () => {
  // Zero and absent are different answers. A screen that renders a caveat only
  // when the field is present would say nothing for an old server AND nothing
  // for a clean ledger, which is the collapse this pair of counts exists to
  // prevent one level down.
  const repo = makeRepo();
  const store = new Store(':memory:');
  let srv: { base: string; close: () => Promise<void> } | null = null;
  try {
    const project = await projectName(repo);
    store.insertRequest(request('in-window', project, COMMIT_MS - HOUR, 6));

    srv = await boot(store);
    const res = await fetch(`${srv.base}/api/value?repo=${encodeURIComponent(repo)}`);
    const payload = (await res.json()) as ValueShape;
    const matured = payload.realization?.matured ?? null;
    assert.ok(matured);
    assert.equal(matured.spendWindowTruncatedUnits, 0);
    assert.equal(matured.spendWindowUnknownUnits, 0);
  } finally {
    await srv?.close();
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

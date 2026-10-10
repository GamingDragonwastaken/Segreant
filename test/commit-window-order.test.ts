/**
 * A request is booked to at most one commit, whatever order `git log` prints.
 *
 * Commit windows ran from "the next commit in the log" to this one. After a
 * rebase, cherry-pick or merge, author times along the log are not monotonic,
 * so the windows overlapped and the same request counted toward two commits.
 * On one real repository 40 windows overlapped and the first-run Kept answer
 * counted $99 of spend twice. Windows are now built in time order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-window-order-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { attributeCommits, projectName } from '../src/git/correlate.ts';

const HOUR = 60 * 60 * 1000;
const T0 = Date.now() - 10 * 24 * HOUR;

function commitAt(repo: string, file: string, msg: string, ms: number): void {
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: env ?? process.env });
  writeFileSync(join(repo, file), `${msg}\n`);
  git(['add', '.']);
  const when = new Date(ms).toISOString();
  // Committer time always moves forward (as after a rebase); author time does not.
  git(['commit', '-qm', msg, '--date', when], { ...process.env, GIT_COMMITTER_DATE: new Date().toISOString() });
}

function request(id: string, project: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5',
    project, taskWeight: 1, inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
    statusCode: 200, durationMs: 1,
  };
}

test('windows tile time even when the log order disagrees with author time', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'segreant-window-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Segreant test'], { cwd: repo });
  // Log order (newest first): C (author T0+3h), B (author T0+1h), A (author T0+5h).
  // In log order, A's window reaches back over C's: the overlap this guards.
  commitAt(repo, 'a.ts', 'A', T0 + 5 * HOUR);
  commitAt(repo, 'b.ts', 'B', T0 + 1 * HOUR);
  commitAt(repo, 'c.ts', 'C', T0 + 3 * HOUR);

  const store = new Store(':memory:');
  const project = await projectName(repo);
  // One request every hour from T0 to T0+5h, $1 each.
  for (let h = 0; h <= 5; h++) store.insertRequest(request(`r${h}`, project, T0 + h * HOUR - 60_000, 1));

  const units = await attributeCommits(store, repo, { limit: 10, scopeProject: project });
  const windows = units.map((u) => [u.windowStartMs, u.windowEndMs] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i]![0] >= windows[i - 1]![1], `window ${i} starts before window ${i - 1} ends`);
  }
  const total = units.reduce((s, u) => s + u.attributedCostUsd, 0);
  assert.ok(total <= 6, `no request is counted twice (attributed $${total} of $6 recorded)`);
  store.close();
});

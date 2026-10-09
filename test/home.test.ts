/**
 * Bare `segreant` is read-only: on a new machine it points at the one command
 * that reads the logs and records nothing; with a ledger it leads with the month.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';

const CLI = fileURLToPath(new URL('../bin/segreant.mjs', import.meta.url));

function run(args: string[], home: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: '', NODE_OPTIONS: '' } }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

test('bare segreant on a new machine says what to run and imports nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-empty-'));
  const r = await run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /what your AI coding spend produced/);
  assert.match(r.stdout, /segreant scan|segreant demo/);
  assert.doesNotMatch(r.stdout, /route one AI tool through the proxy/, 'the log-reading route comes first, not the proxy');
  const json = JSON.parse((await run(['home', '--json'], home)).stdout) as { empty: boolean; last30Days: { requests: number } };
  assert.equal(json.empty, true);
  assert.equal(json.last30Days.requests, 0);
});

test('with a ledger, home leads with the month as list cost', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-full-'));
  const store = new Store(join(home, 'segreant.db'));
  store.insertRequest({
    requestId: 'r1', sessionId: 's', tsEpochMs: Date.now() - 60_000, provider: 'anthropic', model: 'claude-opus-4-8',
    project: 'p', taskWeight: 1, inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 1.25, estimated: false, streamed: false, statusCode: 200, durationMs: 10,
    source: 'claude-code', via: 'import',
  });
  store.close();
  const r = await run(['home'], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Last 30 days\s+\$1\.25 list cost/);
  assert.match(r.stdout, /an estimate, not your bill/);
  assert.ok(existsSync(join(home, 'segreant.db')));
});

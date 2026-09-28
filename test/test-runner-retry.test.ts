/**
 * scripts/run-tests.mjs reruns a file once only when it crashed with no failing
 * test inside it (a Node runtime fault). Real failures and repeat crashes must
 * still fail the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A nested run inherits NODE_TEST_CONTEXT and would report to this harness instead.
const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;

function runner(fixture: string) {
  const dir = mkdtempSync(join(tmpdir(), 'segreant-runner-'));
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/run-tests.mjs', join('test', 'fixtures', 'runner', fixture)], {
      encoding: 'utf8', env: { ...env, RUNNER_FIXTURE_DIR: dir }, timeout: 60_000,
    });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a file that crashes once is rerun alone and the retry is reported', () => {
  const r = runner('crash-once.ts');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /crashed with no failing test inside them; rerunning/);
  assert.match(r.out, /Rerun passed/);
});

test('a file that crashes every time still fails the suite', () => {
  const r = runner('always-crash.ts');
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /Rerun failed as well/);
});

test('a real failing test is never retried', () => {
  const r = runner('real-failure.ts');
  assert.notEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /rerunning/);
});

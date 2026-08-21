/**
 * `fiscus team push` CLI-level checks — integration-tested through the
 * real CLI process, same pattern as test/exec.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, FISCUS_HOME: home, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('team push: no realized units in the window reports ok:true (projects:0) in JSON mode, agreeing with exit code 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-push-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    const r = await runCli(['team', 'push', '--url', 'http://127.0.0.1:1', '--json'], db, home);
    assert.equal(r.code, 0, `a fresh install with no realized units must not be treated as a failure, stderr: ${r.stderr}`);
    const payload = JSON.parse(r.stdout) as { ok: boolean; projects: number };
    assert.equal(payload.ok, true, 'JSON ok must agree with the process exit code (both success)');
    assert.equal(payload.projects, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team push --watch: refuses to start without --url — nothing to poll into, exit 1, no hang', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-push-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    const r = await runCli(['team', 'push', '--watch', '--json'], db, home);
    assert.equal(r.code, 1, `--watch with no --url must fail fast rather than hang waiting for input, stdout: ${r.stdout}`);
    const payload = JSON.parse(r.stdout) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /--url/, 'error must point the user at the missing flag, not a generic failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team push: refuses a non-loopback plaintext HTTP endpoint before reading or sending a rollup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-push-'));
  try {
    const db = join(dir, 'push.db');
    const home = join(dir, 'home');
    const r = await runCli(['team', 'push', '--url', 'http://team.example.test:8787', '--json'], db, home);
    assert.equal(r.code, 1, `public plaintext HTTP must fail closed, stderr: ${r.stderr}`);
    const payload = JSON.parse(r.stdout) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /plaintext HTTP/i);
    assert.match(payload.error, /HTTPS/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const endpoint of [
  'https://team.example.test:8787',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://[::1]:8787',
]) {
  test(`team push: permits HTTPS or explicit loopback HTTP (${endpoint})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiscus-team-push-'));
    try {
      const db = join(dir, 'push.db');
      const home = join(dir, 'home');
      // A fresh database has no realized projects, so this asserts the transport
      // gate permits the endpoint without making any outbound request.
      const r = await runCli(['team', 'push', '--url', endpoint, '--json'], db, home);
      assert.equal(r.code, 0, `endpoint should pass the transport gate, stderr: ${r.stderr}`);
      const payload = JSON.parse(r.stdout) as { ok: boolean; projects: number };
      assert.equal(payload.ok, true);
      assert.equal(payload.projects, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

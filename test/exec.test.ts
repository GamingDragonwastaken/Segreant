/**
 * Ambient outcome capture (`fiscus exec -- <cmd>`): the wrapper must record
 * the wrapped command's exit code as an outcome signal AND stay transparent
 * (same exit code out as in). Integration-tested through the real CLI process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, NODE_OPTIONS: '' } },
      (err, _stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stderr: String(stderr) });
      },
    );
  });
}

test('exec: a passing command records verdict=pass and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-exec-'));
  const db = join(dir, 'exec.db');
  try {
    const r = await runCli(['exec', '--kind', 'resolved', '--session', 'amb-1', '--', 'node', '-e', 'process.exit(0)'], db);
    assert.equal(r.code, 0, `transparent pass-through, stderr: ${r.stderr}`);
    const store = new Store(db);
    const sigs = store.signalsForCommit('amb-1');
    store.close();
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0]!.kind, 'resolved');
    assert.equal(sigs[0]!.verdict, 'pass');
    const detail = JSON.parse(sigs[0]!.detail ?? '{}');
    assert.equal(detail.source, 'local-command', 'signal retains local-command provenance');
    assert.equal(detail.command, 'node -e process.exit(0)');
    assert.equal(detail.exitCode, 0);
    assert.equal(typeof detail.seconds, 'number');
    assert.equal(sigs[0]!.evidenceSource, 'local-command');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exec: a failing command records verdict=fail and passes the exit code through unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-exec-'));
  const db = join(dir, 'exec.db');
  try {
    const r = await runCli(['exec', '--kind', 'used', '--session', 'amb-2', '--', 'node', '-e', 'process.exit(3)'], db);
    assert.equal(r.code, 3, 'the pipeline must see the real exit code');
    const store = new Store(db);
    const sigs = store.signalsForCommit('amb-2');
    store.close();
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0]!.verdict, 'fail', 'non-zero exit is an honest fail, never softened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exec: refuses bad input without running anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-exec-'));
  const db = join(dir, 'exec.db');
  try {
    const noCmd = await runCli(['exec', '--kind', 'tested'], db);
    assert.notEqual(noCmd.code, 0, 'no wrapped command → error');

    const badKind = await runCli(['exec', '--kind', 'sparkles', '--', 'node', '-e', '0'], db);
    assert.notEqual(badKind.code, 0, 'unknown kind → error');

    const usageNoSession = await runCli(['exec', '--kind', 'published', '--', 'node', '-e', '0'], db);
    assert.notEqual(usageNoSession.code, 0, 'usage kind without --session → error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report: a coding lifecycle assertion without an immutable commit is rejected and not stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-report-'));
  const db = join(dir, 'report.db');
  try {
    const r = await runCli(['report', '--kind', 'tested'], db);
    assert.notEqual(r.code, 0, 'a code outcome without --commit must be rejected');
    assert.match(r.stderr, /needs --commit/i);
    const store = new Store(db);
    assert.equal(store.signalsInWindow('default', 0, Date.now()).length, 0, 'no project-wide code signal is created');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

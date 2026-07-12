/**
 * `fiscus judge` CLI-level checks — integration-tested through the real
 * CLI process, same pattern as test/team-push.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, AEGIS_DB: dbPath, AEGIS_HOME: home, NODE_OPTIONS: '' }, cwd },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('judge: explicit --project with no judge tier configured (the default) returns the algorithmic signal, valid shape, exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r = await runCli(['judge', '--project', 'test-project', '--json'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    const judgment = JSON.parse(r.stdout) as {
      sessionId: string;
      efficiencyMultiplier: number;
      confidence: string;
      rationale: string;
    };
    assert.equal(judgment.confidence, 'algorithmic', 'default config has no judge tier configured, must degrade to algorithmic, never claim a richer tier');
    assert.equal(typeof judgment.sessionId, 'string');
    assert.ok(judgment.sessionId.length > 0, 'sessionId must be a real generated id, not empty');
    assert.equal(typeof judgment.efficiencyMultiplier, 'number');
    assert.ok(Number.isFinite(judgment.efficiencyMultiplier), 'efficiencyMultiplier must be a finite number, never NaN/Infinity');
    assert.equal(typeof judgment.rationale, 'string');
    assert.ok(judgment.rationale.length > 0, 'rationale must be non-empty — never a silently blank explanation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: two invocations produce different sessionIds (never reused across separate ad-hoc judgments)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r1 = await runCli(['judge', '--project', 'test-project', '--json'], db, home);
    const r2 = await runCli(['judge', '--project', 'test-project', '--json'], db, home);
    const j1 = JSON.parse(r1.stdout) as { sessionId: string };
    const j2 = JSON.parse(r2.stdout) as { sessionId: string };
    assert.notEqual(j1.sessionId, j2.sessionId, 'each CLI invocation is its own ad-hoc judged window, not a looked-up session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: no --project and cwd is not a git repo reports a clear error, exit 1, nothing crashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  const notARepo = mkdtempSync(join(tmpdir(), 'aegis-judge-notrepo-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r = await runCli(['judge'], db, home, notARepo);
    assert.equal(r.code, 1, `expected failure outside a git repo without --project, stdout: ${r.stdout}`);
    assert.match(r.stderr, /not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test('judge: custom --window is accepted and still resolves cleanly against a fresh, empty store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r = await runCli(['judge', '--project', 'test-project', '--window', '7', '--json'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    const judgment = JSON.parse(r.stdout) as { confidence: string };
    assert.equal(judgment.confidence, 'algorithmic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: non-JSON mode prints human-readable output without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r = await runCli(['judge', '--project', 'test-project'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    assert.match(r.stdout, /session judge/i);
    assert.match(r.stdout, /algorithmic/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

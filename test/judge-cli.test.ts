/**
 * `fiscus judge` CLI-level checks — integration-tested through the real
 * CLI process, same pattern as test/team-push.test.ts.
 *
 * Since the R4 change, `judge` looks up REAL sessions from the store (default:
 * most recent activity in the window; `--session <id>` to pick) instead of
 * inventing an ad-hoc session id — so these tests seed the store first and
 * assert the judgment names the session that actually happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], dbPath: string, home: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_DB: dbPath, FISCUS_HOME: home, NODE_OPTIONS: '' }, cwd },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: Date.now(), provider: 'anthropic',
    model: 'm', project: 'test-project', taskWeight: 1, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0.01, estimated: false, streamed: false, statusCode: 200,
    durationMs: 100, ...over,
  };
}

/** Seed one real session with two requests inside the default 1d window. */
function seedSession(dbPath: string, sessionId: string, tsEpochMs: number): void {
  const store = new Store(dbPath);
  store.upsertSession(sessionId, 'test-project', 'proxy', tsEpochMs);
  store.insertRequest(req({ sessionId, tsEpochMs }));
  store.insertRequest(req({ sessionId, tsEpochMs: tsEpochMs + 30_000 }));
  store.close();
}

test('judge: with a seeded session and no judge tier configured (the default), judges THAT session algorithmically, exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    seedSession(db, 'real-session-1', Date.now() - 60_000);
    const r = await runCli(['judge', '--project', 'test-project', '--json'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    const judgment = JSON.parse(r.stdout) as {
      sessionId: string;
      efficiencyMultiplier: number;
      confidence: string;
      rationale: string;
    };
    assert.equal(judgment.sessionId, 'real-session-1', 'must judge the session that actually happened, never an invented id');
    assert.equal(judgment.confidence, 'algorithmic', 'default config has no judge tier configured, must degrade to algorithmic, never claim a richer tier');
    assert.equal(typeof judgment.efficiencyMultiplier, 'number');
    assert.ok(Number.isFinite(judgment.efficiencyMultiplier), 'efficiencyMultiplier must be a finite number, never NaN/Infinity');
    assert.ok(judgment.rationale.length > 0, 'rationale must be non-empty — never a silently blank explanation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: default picks the newest-activity session; --session <id> picks a specific one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    seedSession(db, 'older-session', Date.now() - 3_600_000);
    seedSession(db, 'newer-session', Date.now() - 60_000);

    const byDefault = await runCli(['judge', '--project', 'test-project', '--json'], db, home);
    assert.equal((JSON.parse(byDefault.stdout) as { sessionId: string }).sessionId, 'newer-session');

    const picked = await runCli(['judge', '--project', 'test-project', '--session', 'older-session', '--json'], db, home);
    assert.equal((JSON.parse(picked.stdout) as { sessionId: string }).sessionId, 'older-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('judge: an empty store reports no-sessions honestly — JSON error shape, exit 0, no invented judgment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    const r = await runCli(['judge', '--project', 'test-project', '--window', '7', '--json'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as { error: string; sessions: number };
    assert.equal(out.error, 'no-sessions-in-window');
    assert.equal(out.sessions, 0);
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

test('judge: non-JSON mode prints human-readable output naming the session and tool, without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-judge-'));
  try {
    const db = join(dir, 'judge.db');
    const home = join(dir, 'home');
    seedSession(db, 'human-session', Date.now() - 60_000);
    const r = await runCli(['judge', '--project', 'test-project'], db, home);
    assert.equal(r.code, 0, `expected success, stderr: ${r.stderr}`);
    assert.match(r.stdout, /session judge/i);
    assert.match(r.stdout, /human-session/);
    assert.match(r.stdout, /tool: proxy/);
    assert.match(r.stdout, /algorithmic/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

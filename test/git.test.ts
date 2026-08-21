import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { readCommits, attributeCommits } from '../src/git/correlate.ts';

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-git-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t.co']);
  g(dir, ['config', 'user.name', 'tester']);
  return dir;
}

function commit(dir: string, file: string, content: string, msg: string, iso: string): void {
  writeFileSync(join(dir, file), content);
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', msg, `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

test('readCommits parses numstat line counts and subjects', async () => {
  const dir = makeRepo();
  try {
    commit(dir, 'a.txt', 'one\ntwo\n', 'feat: first', '2026-06-01T10:00:00');
    const commits = await readCommits(dir, 50);
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.subject, 'feat: first');
    assert.equal(commits[0]!.linesAdded, 2);
    assert.equal(commits[0]!.linesDeleted, 0);
    assert.equal(commits[0]!.filesChanged, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attributeCommits assigns spend to the window before a commit', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'feat: more', '2026-06-01T11:00:00+00:00');

    // Spend at 10:30 — inside commit 2's window [10:00, 11:00).
    store.insertRequest({
      requestId: 'r1',
      sessionId: null,
      tsEpochMs: Date.parse('2026-06-01T10:30:00Z'),
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      project: 'p',
      taskWeight: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.42,
      estimated: false,
      streamed: false,
      statusCode: 200,
      durationMs: 10,
    });

    const rows = await attributeCommits(store, dir, { limit: 5 });
    const more = rows.find((r) => r.subject === 'feat: more');
    const base = rows.find((r) => r.subject === 'feat: base');
    assert.ok(more && base, 'both commits present');
    assert.ok(Math.abs(more!.attributedCostUsd - 0.42) < 1e-9, `got ${more!.attributedCostUsd}`);
    assert.equal(more!.attributedRequests, 1);
    assert.equal(base!.attributedCostUsd, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

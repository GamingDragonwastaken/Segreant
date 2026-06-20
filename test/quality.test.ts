import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { computeQuality } from '../src/git/quality.ts';

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-q-'));
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

test('survival drops when a commit\'s lines are later rewritten (churn)', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    // Commit 1 (old enough to be "matured"): 4 lines.
    commit(dir, 'a.txt', 'a1\na2\na3\na4\n', 'feat: four lines', '2026-01-01T10:00:00+00:00');
    // Commit 2: rewrite half of them (a3, a4 → b3, b4). a1, a2 survive.
    commit(dir, 'a.txt', 'a1\na2\nb3\nb4\n', 'fix: rewrite two', '2026-01-02T10:00:00+00:00');

    const report = await computeQuality(store, dir, { limit: 10, windowDays: 14 });
    const c1 = report.commits.find((c) => c.subject === 'feat: four lines');
    assert.ok(c1, 'commit 1 present');
    // Commit 1 added 4 lines; 2 survive at HEAD.
    assert.equal(c1!.linesAdded, 4);
    assert.equal(c1!.survivingLines, 2);
    assert.ok(Math.abs(c1!.survivalRatio - 0.5) < 1e-9, `survival ${c1!.survivalRatio}`);
    assert.ok(Math.abs(c1!.churnRatio - 0.5) < 1e-9);
    assert.equal(c1!.maturing, false, 'old commit is matured');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI Yield = surviving lines per dollar of attributed spend', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'seed.txt', 'seed\n', 'feat: base', '2026-01-01T10:00:00+00:00');
    // Commit 2 adds 10 lines in a NEW file, all survive (nothing after it).
    // Kept separate from the base file so only this commit's lines are counted.
    commit(dir, 'work.txt', Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n') + '\n', 'feat: ten', '2026-01-02T10:00:00+00:00');

    // $2.00 of spend in the window before commit 2 (between base and ten).
    store.insertRequest({
      requestId: 'r', sessionId: null, tsEpochMs: Date.parse('2026-01-02T09:30:00Z'),
      provider: 'anthropic', model: 'claude-opus-4-8', project: 'p', taskWeight: 1,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: 2.0, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    });

    const report = await computeQuality(store, dir, { limit: 10, windowDays: 14 });
    const ten = report.commits.find((c) => c.subject === 'feat: ten');
    assert.ok(ten, 'commit present');
    assert.equal(ten!.survivingLines, 10);
    assert.ok(Math.abs(ten!.attributedCostUsd - 2.0) < 1e-9, `cost ${ten!.attributedCostUsd}`);
    // Yield = 10 surviving lines / $2 = 5.0 lines per dollar.
    assert.ok(ten!.aiYield !== null && Math.abs(ten!.aiYield - 5.0) < 1e-9, `yield ${ten!.aiYield}`);
    // Matured aggregate reflects it.
    assert.ok(report.matured.aiYield !== null && Math.abs(report.matured.aiYield - 5.0) < 1e-9);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

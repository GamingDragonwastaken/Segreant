import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { computeRealization } from '../src/value/realization.ts';
import { projectName, resolveCommit } from '../src/git/correlate.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('realization: an unbound project-window test assertion cannot certify a different code commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fiscus-evidence-binding-'));
  const store = new Store(':memory:');
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Fiscus test']);
    writeFileSync(join(repo, 'app.ts'), 'export const answer = 42;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'feat: a real commit']);

    const hash = (await resolveCommit(repo, 'HEAD'))!;
    const project = await projectName(repo);
    store.insertSignal({
      signalId: 'legacy-project-window-test',
      kind: 'tested',
      commitHash: null,
      project,
      tsEpochMs: Date.now(),
      verdict: 'pass',
      detail: JSON.stringify({ source: 'manual', assertion: 'old project-wide test claim' }),
      evidenceSource: 'manual',
    });

    const report = await computeRealization(store, repo, { limit: 10, windowDays: 365 });
    const unit = report.units.find((candidate) => candidate.hash === hash)!;
    assert.ok(unit, 'the committed work unit is present');
    assert.equal(unit.funnel.results.find((gate) => gate.gate === 'tested')!.verdict, 'unknown');
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

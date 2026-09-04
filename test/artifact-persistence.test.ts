import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import {
  ARTIFACT_PERSISTENCE_CONSTRUCT,
  computeArtifactPersistence,
} from '../src/git/quality.ts';

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-persistence-'));
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

test('artifact persistence reports retained introduced lines without a quality claim', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'a1\na2\na3\na4\n', 'feat: four lines', '2026-01-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'a1\na2\nb3\nb4\n', 'fix: rewrite two', '2026-01-02T10:00:00+00:00');

    const report = await computeArtifactPersistence(store, dir, { limit: 10, windowDays: 14 });
    const first = report.commits.find((commit) => commit.subject === 'feat: four lines');

    assert.equal(report.construct, ARTIFACT_PERSISTENCE_CONSTRUCT);
    assert.equal(report.measurementModel.targetConstruct, ARTIFACT_PERSISTENCE_CONSTRUCT);
    assert.match(report.claim, /introduced artifact lines remain/i);
    assert.deepEqual(report.nonClaims, [
      'semantic correctness',
      'maintainability',
      'business value',
      'code quality',
      'AI or human contribution',
    ]);
    assert.ok(first, 'commit is present');
    assert.equal(first!.artifactPersistence.construct, ARTIFACT_PERSISTENCE_CONSTRUCT);
    assert.equal(first!.artifactPersistence.introducedLines, 4);
    assert.equal(first!.artifactPersistence.retainedLines, 2);
    assert.equal(first!.artifactPersistence.retentionRatio, 0.5);
    assert.equal(first!.linesAdded, 4, 'legacy compatibility field remains');
    assert.equal(first!.survivingLines, 2, 'legacy compatibility field remains');
    assert.doesNotMatch(JSON.stringify(report), /surviving lines prove code quality/i);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy quality entry point preserves its output while exposing persistence semantics', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'work.txt', 'one\ntwo\n', 'feat: work', '2026-01-01T10:00:00+00:00');

    const { computeQuality } = await import('../src/git/quality.ts');
    const report = await computeQuality(store, dir, { limit: 10, windowDays: 14 });

    assert.equal(report.construct, ARTIFACT_PERSISTENCE_CONSTRUCT);
    assert.equal(report.commits[0]!.survivingLines, report.commits[0]!.artifactPersistence.retainedLines);
    assert.equal(report.matured.artifactPersistence.retainedLines, 2);
    assert.equal(report.matured.survivingLines, 0, 'legacy AI-scoped projection remains unchanged without attributed spend');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
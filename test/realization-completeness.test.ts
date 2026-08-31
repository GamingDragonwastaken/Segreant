import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectName } from '../src/git/correlate.ts';
import { completenessWitness } from '../src/measurement/completeness.ts';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';
import { Store } from '../src/store/db.ts';
import { computeRealization } from '../src/value/realization.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-realization-completeness-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Fiscus test']);
  writeFileSync(join(dir, 'app.ts'), 'export const answer = 42;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat: complete boundary test', '--date=2026-01-01T10:00:00Z'],);
  return dir;
}

function cleanWitnesses(project: string) {
  const witnessScope = scope({ project });
  const period = interval('2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  return [
    completenessWitness({
      id: 'complete-incident-source',
      sourceId: 'incident-feed',
      state: 'supported',
      eventTypes: ['linked_incident'],
      scope: witnessScope,
      period,
    }),
    completenessWitness({
      id: 'complete-revert-scan',
      sourceId: 'git-history',
      state: 'supported',
      eventTypes: ['commit_reverted'],
      scope: witnessScope,
      period,
    }),
  ];
}

test('mature coding clean remains unknown when no completeness witness covers the negative channels', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const report = await computeRealization(store, repo, { limit: 2, windowDays: 14 });
    const unit = report.units[0]!;
    assert.equal(unit.maturing, false);
    assert.equal(unit.funnel.results.find((result) => result.gate === 'clean')!.verdict, 'unknown');
    assert.equal(unit.funnel.realized, false);
    assert.equal(unit.cleanCompleteness?.qualified, false);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('clean passes only when supported witnesses cover both revert and incident channels', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    const report = await computeRealization(store, repo, {
      limit: 2,
      windowDays: 14,
      completenessWitnesses: cleanWitnesses(project),
    });
    const unit = report.units[0]!;
    assert.equal(unit.funnel.results.find((result) => result.gate === 'clean')!.verdict, 'pass');
    assert.equal(unit.cleanCompleteness?.qualified, true);
    assert.deepEqual(unit.cleanCompleteness?.qualifyingWitnessIds, [
      'complete-incident-source',
      'complete-revert-scan',
    ]);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a witness for only one negative channel leaves the clean predicate unresolved', async () => {
  const repo = makeRepo();
  const store = new Store(':memory:');
  try {
    const project = await projectName(repo);
    const [incident] = cleanWitnesses(project);
    const report = await computeRealization(store, repo, {
      limit: 2,
      windowDays: 14,
      completenessWitnesses: [incident!],
    });
    const unit = report.units[0]!;
    assert.equal(unit.funnel.results.find((result) => result.gate === 'clean')!.verdict, 'unknown');
    assert.equal(unit.cleanCompleteness?.qualified, false);
    assert.deepEqual(unit.cleanCompleteness?.qualifyingWitnessIds, ['complete-incident-source']);
  } finally {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

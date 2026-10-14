/**
 * Survival work kept between runs: a later run reuses an earlier run's blame
 * only when it is provably the same observation at the current HEAD, and
 * every reused answer equals what a fresh, uncached measurement gives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { survivingLines, clearBlameCache, survivalGitRuns, resetSurvivalGitRuns, type SurvivingLines } from '../src/git/quality.ts';
import { configureSurvivalStore, forgetLoadedSurvivalStore, flushSurvivalStore } from '../src/git/survivalStore.ts';

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i}`).join('\n') + '\n';
}

test('a later run reuses survival work only when it is the same observation, and never changes an answer', async () => {
  const base = mkdtempSync(join(tmpdir(), 'segreant-survival-store-'));
  const repo = join(base, 'repo');
  const store = join(base, 'store');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  }).trim();
  const write = (file: string, text: string) => writeFileSync(join(repo, file), text);

  // A new process: nothing in memory, only what the store holds on disk.
  const newProcess = () => { forgetLoadedSurvivalStore(); clearBlameCache(); resetSurvivalGitRuns(); };
  const measure = async (hashes: string[], sinceSec?: number): Promise<SurvivingLines[]> => {
    const out: SurvivingLines[] = [];
    for (const h of hashes) out.push(await survivingLines(repo, h, undefined, sinceSec));
    return out;
  };
  // The same measurement with the store off and nothing cached: the reference.
  const fresh = async (hashes: string[], sinceSec?: number): Promise<SurvivingLines[]> => {
    configureSurvivalStore(null);
    clearBlameCache();
    try { return await measure(hashes, sinceSec); } finally { configureSurvivalStore(store); clearBlameCache(); }
  };

  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    write('a.txt', lines('a', 10)); write('b.txt', lines('b', 10)); write('c.txt', lines('c', 10));
    git('add', '.'); git('commit', '-qm', 'one');
    const c1 = git('rev-parse', 'HEAD');
    write('a.txt', lines('a', 10) + 'a added by two\n');
    git('commit', '-qam', 'two');
    const c2 = git('rev-parse', 'HEAD');
    const both = [c1, c2];

    configureSurvivalStore(store);
    newProcess();
    const cold = await measure(both);
    assert.deepEqual(survivalGitRuns(), { blame: 3, numstat: 2 }, 'cold: one blame per file, one file list per commit');
    assert.deepEqual(cold, await fresh(both));
    flushSurvivalStore();
    assert.equal(readdirSync(store).filter((f) => f.endsWith('.json')).length, 1, 'one store file for the repository');

    newProcess();
    assert.deepEqual(await measure(both), cold, 'same HEAD: the same answers');
    assert.deepEqual(survivalGitRuns(), { blame: 0, numstat: 0 }, 'same HEAD: no git work at all');

    // A new commit that touches b only: a and c are still the same observation.
    write('b.txt', lines('b', 5));
    git('commit', '-qam', 'three: shrink b');
    newProcess();
    const afterThree = await measure(both);
    assert.equal(survivalGitRuns().blame, 1, 'only the touched file is blamed again');
    assert.deepEqual(afterThree, await fresh(both));
    assert.notDeepEqual(afterThree, cold, 'b lost lines, so c1 retains fewer');

    // History rewritten: the stored HEAD is no longer an ancestor.
    write('b.txt', lines('b', 6));
    git('commit', '-q', '--amend', '-am', 'three, amended');
    newProcess();
    const amended = await measure(both);
    assert.equal(survivalGitRuns().blame, 3, 'a rewritten history re-blames every file');
    assert.deepEqual(amended, await fresh(both));
    newProcess();
    await measure(both);
    assert.equal(survivalGitRuns().blame, 0, 'after re-blaming once, the amended HEAD is reusable');
    write('c.txt', lines('c', 10) + 'temporary\n');
    git('commit', '-qam', 'four: change c');
    write('c.txt', lines('c', 10));
    git('commit', '-qam', 'five: revert c');
    git('commit', '-q', '--amend', '-m', 'five, reworded');
    newProcess();
    const rewritten = await measure(both);
    assert.ok(survivalGitRuns().blame >= 1, 'c is blamed again although its contents are unchanged');
    assert.deepEqual(rewritten, await fresh(both), 'a change and its revert reattribute lines; the answer still matches git');

    // History bound: an older bound than the stored one needs exact counts the
    // stored blame collapsed, so it is blamed again; a newer one is reusable.
    // An unbounded blame is exact for every bound, so start from an empty store.
    const t1 = Number(git('log', '-1', '--format=%ct', c1));
    flushSurvivalStore();
    rmSync(store, { recursive: true, force: true });
    newProcess();
    await measure(both, t1 - 100);
    assert.equal(survivalGitRuns().blame, 3, 'a bounded blame is stored with its bound');
    newProcess();
    const older = await measure(both, t1 - 200);
    assert.equal(survivalGitRuns().blame, 3, 'an older bound than stored is blamed again');
    assert.deepEqual(older, await fresh(both, t1 - 200));
    newProcess();
    const newer = await measure(both, t1 - 50);
    assert.equal(survivalGitRuns().blame, 0, 'a newer bound than stored reuses it');
    assert.deepEqual(newer, await fresh(both, t1 - 50));

    // A corrupt store is ignored, not trusted and not fatal.
    flushSurvivalStore();
    for (const f of readdirSync(store)) writeFileSync(join(store, f), '{not json');
    newProcess();
    assert.deepEqual(await measure(both), await fresh(both));
  } finally {
    configureSurvivalStore(null);
    clearBlameCache();
    rmSync(base, { recursive: true, force: true });
  }
});

test('the store is off unless an entry point turns it on', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'segreant-survival-off-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    configureSurvivalStore(null);
    clearBlameCache(); resetSurvivalGitRuns();
    await survivingLines(repo, head);
    clearBlameCache();
    forgetLoadedSurvivalStore();
    await survivingLines(repo, head);
    assert.equal(survivalGitRuns().blame, 2, 'nothing was kept between the two runs');
  } finally {
    clearBlameCache();
    rmSync(repo, { recursive: true, force: true });
  }
});

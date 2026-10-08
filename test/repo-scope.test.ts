/**
 * The repository spend scope accepts a commit observation only when git agrees
 * (sha, subject, time), and links a folder as a whole only when it is gone or
 * is a checkout of the same repository. A parent folder is never linked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { repoSpendScope, subjectsAgree } from '../src/git/repoScope.ts';

const COMMIT_SEC = 1_790_000_000; // a fixed commit time
const COMMIT_MS = COMMIT_SEC * 1000;

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_AUTHOR_DATE: `${COMMIT_SEC} +0000`, GIT_COMMITTER_DATE: `${COMMIT_SEC} +0000`,
    },
  }).trim();
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'scope-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  gitIn(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  gitIn(repo, ['add', '.']);
  gitIn(repo, ['commit', '-q', '-m', 'Measure the period the spend covers']);
  const sha = gitIn(repo, ['rev-parse', 'HEAD']);
  const worktree = join(parent, 'wt');
  gitIn(repo, ['worktree', 'add', '-q', worktree]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'scope-db-')), 'test.db'));
  return { parent, repo, sha, worktree, store };
}

const obs = (over: Partial<Parameters<Store['recordObservedCommit']>[0]>) => ({
  source: 'claude-code', sessionId: 's', shortSha: '0000000', branch: 'main',
  subject: 'Measure the period the spend covers', tsEpochMs: COMMIT_MS, cwd: null, ...over,
});

test('subjects agree on a shared prefix and not otherwise', () => {
  assert.equal(subjectsAgree('Fix the import', 'Fix the import'), true);
  assert.equal(subjectsAgree('Fix the import', 'Fix the import and the export'), true);
  assert.equal(subjectsAgree('Fix the import', 'Add a check'), false);
  assert.equal(subjectsAgree('', 'Add a check'), false);
});

test('an observation counts only when sha, subject and time all match the repository', async () => {
  const { repo, sha, store } = fixture();
  const short = sha.slice(0, 7);
  store.recordObservedCommit(obs({ sessionId: 'good', shortSha: short }));
  store.recordObservedCommit(obs({ sessionId: 'wrong-subject', shortSha: short, subject: 'Something else entirely' }));
  store.recordObservedCommit(obs({ sessionId: 'wrong-time', shortSha: short, tsEpochMs: COMMIT_MS + 31 * 60 * 1000 }));
  store.recordObservedCommit(obs({ sessionId: 'no-such-commit', shortSha: '1a2b3c4' }));
  const scope = await repoSpendScope(store, repo);
  assert.equal(scope.verifiedObservations, 1);
  assert.deepEqual([...scope.linkedSessions], ['good']);
  assert.equal(scope.extended, true);
  assert.equal(scope.matches({ project: 'elsewhere', sessionId: 'good' }), true);
  assert.equal(scope.matches({ project: 'elsewhere', sessionId: 'wrong-subject' }), false);
  store.close();
});

test('a moved folder and a worktree are linked; an existing parent folder is not', async () => {
  const { parent, repo, sha, worktree, store } = fixture();
  const short = sha.slice(0, 7);
  const gone = join(parent, 'old-checkout-that-moved');
  store.recordObservedCommit(obs({ sessionId: 'a', shortSha: short, cwd: gone }));
  store.recordObservedCommit(obs({ sessionId: 'b', shortSha: short, cwd: worktree }));
  store.recordObservedCommit(obs({ sessionId: 'c', shortSha: short, cwd: parent }));
  const scope = await repoSpendScope(store, repo);
  const reasons = Object.fromEntries(scope.linkedFolders.map((f) => [f.path, f.reason]));
  assert.deepEqual(reasons, { [gone]: 'moved', [worktree]: 'worktree' });
  // Other work in the moved folder or the worktree belongs here...
  assert.equal(scope.matches({ project: 'x', sessionId: 'other', cwd: join(gone, 'src') }), true);
  assert.equal(scope.matches({ project: 'x', sessionId: 'other', cwd: worktree }), true);
  // ...but the parent folder's other sessions do not; only its verified one does.
  assert.equal(scope.matches({ project: 'x', sessionId: 'other', cwd: parent }), false);
  assert.equal(scope.matches({ project: 'x', sessionId: 'c', cwd: parent }), true);
  store.close();
});

test('with no observations the scope is the label alone', async () => {
  const { repo, store } = fixture();
  const scope = await repoSpendScope(store, repo);
  assert.equal(scope.extended, false);
  assert.equal(scope.matches({ project: 'repo', sessionId: null }), true);
  assert.equal(scope.matches({ project: 'other', sessionId: 'any' }), false);
  store.close();
});

test('another checkout of the same repository (a clone) is linked as a whole; an unrelated repository is not', async () => {
  const { parent, repo, sha, store } = fixture();
  const clone = join(parent, 'agent-copy');
  execFileSync('git', ['clone', '-q', repo, clone]);
  const other = join(parent, 'unrelated');
  mkdirSync(other);
  gitIn(other, ['init', '-q', '-b', 'main']);
  writeFileSync(join(other, 'b.txt'), 'two\n');
  gitIn(other, ['add', '.']);
  gitIn(other, ['commit', '-q', '-m', 'Unrelated work']);
  const short = sha.slice(0, 7);
  store.recordObservedCommit(obs({ sessionId: 'in-clone', shortSha: short, cwd: join(clone) }));
  store.recordObservedCommit(obs({ sessionId: 'in-other', shortSha: short, cwd: other }));
  const scope = await repoSpendScope(store, repo);
  const reasons = Object.fromEntries(scope.linkedFolders.map((f) => [f.path, f.reason]));
  assert.equal(reasons[clone], 'clone');
  assert.equal(reasons[other], undefined, 'a repository with different roots is never linked as a whole');
  assert.equal(scope.matches({ project: 'x', sessionId: 'someone-else', cwd: clone }), true);
  assert.equal(scope.matches({ project: 'x', sessionId: 'someone-else', cwd: other }), false);
  store.close();
});

/**
 * System scan: the proactive discovery pass must be bounded, read-only, and honest.
 * The filesystem walker finds git repos without wandering the disk (depth cap, visit
 * budget, skip-list, no symlink following, no descent into a repo), tool detection
 * returns a stable typed shape, and the plan splits found repos into "already valued"
 * vs "needs an import" using the same project key the correlation bridge uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { detectTools, findGitRepos, planScan, diffScan, scanWithDiff, saveScan, type ScanPlan, type ScanSnapshot } from '../src/scan/scan.ts';

/** Make a directory (recursively) under root and return its absolute path. */
function dir(root: string, ...segs: string[]): string {
  const p = join(root, ...segs);
  mkdirSync(p, { recursive: true });
  return p;
}

/** Mark a directory as a git repo by giving it a .git child (dir, as normal repos have). */
function makeRepo(path: string): string {
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

test('findGitRepos: finds nested repos incl. an umbrella parent; prunes vendored + hidden', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-'));
  const repoA = makeRepo(dir(root, 'code', 'project-a'));
  const repoB = makeRepo(dir(root, 'code', 'nested', 'project-b'));
  // An UMBRELLA repo: a parent folder that is itself a git repo AND contains an
  // independent child repo (the real "git-init'd projects folder" case). BOTH
  // must be found — recording a repo must not stop the descent.
  const umbrella = makeRepo(dir(root, 'umbrella'));
  const child = makeRepo(dir(umbrella, 'child-proj'));
  // A vendored repo inside node_modules must never be reported (skip-list prunes it).
  makeRepo(dir(repoA, 'node_modules', 'vendored-lib'));
  // A repo under a hidden dir must be pruned (hidden dirs are not project roots).
  makeRepo(dir(root, '.cache', 'hidden-repo'));

  const res = findGitRepos([root]);
  const found = new Set(res.repos);
  assert.ok(found.has(repoA), 'top-level repo found');
  assert.ok(found.has(repoB), 'nested (non-hidden) repo found');
  assert.ok(found.has(umbrella), 'umbrella parent repo found');
  assert.ok(found.has(child), 'child repo under the umbrella is NOT hidden by the parent');
  assert.equal(found.has(join(repoA, 'node_modules', 'vendored-lib')), false, 'vendored repo under node_modules is pruned');
  assert.equal([...found].some((r) => r.includes('.cache')), false, 'repo under a hidden dir is pruned');
  assert.equal(res.hitBudget, false);
});

test('findGitRepos: respects maxDepth — a repo deeper than the cap is not found', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-depth-'));
  makeRepo(dir(root, 'a', 'b', 'c', 'deep-repo')); // .git at depth 4 from root

  const shallow = findGitRepos([root], { maxDepth: 2 });
  assert.equal(shallow.repos.length, 0, 'depth 2 cannot reach a repo at depth 4');

  const deep = findGitRepos([root], { maxDepth: 6 });
  assert.equal(deep.repos.length, 1, 'a deeper cap reaches it');
});

test('findGitRepos: honors the visit budget and flags partial results', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-budget-'));
  for (let i = 0; i < 20; i++) dir(root, `folder-${i}`, 'sub');

  const res = findGitRepos([root], { maxDirs: 3 });
  assert.equal(res.hitBudget, true, 'budget exhausted → flagged');
  assert.ok(res.dirsVisited <= 4, 'stops promptly at the budget');
});

test('findGitRepos: a nonexistent root is dropped, not thrown', () => {
  const res = findGitRepos([join(tmpdir(), 'definitely-not-here-xyz')]);
  assert.deepEqual(res.repos, []);
  assert.deepEqual(res.roots, [], 'the missing root is not reported as walked');
});

test('detectTools: returns the three supported tools with a stable typed shape', () => {
  const tools = detectTools();
  assert.deepEqual(tools.map((t) => t.id).sort(), ['claude-code', 'codex', 'opencode']);
  for (const t of tools) {
    assert.equal(typeof t.present, 'boolean');
    assert.ok(t.label.length > 0);
    assert.ok(t.blurb.length > 0);
    // Invariant: a present tool has a data path; an absent one does not.
    assert.equal(t.present, t.dataPath !== null, `${t.id}: present iff dataPath`);
  }
});

test('planScan: splits found repos into RoI-ready vs needs-import by project key', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-plan-'));
  const withSpend = makeRepo(dir(root, 'metered-proj'));
  makeRepo(dir(root, 'fresh-proj'));

  const store = new Store(join(mkdtempSync(join(tmpdir(), 'scan-store-')), 'test.db'));
  // Give one of the repos imported spend by recording a request whose cwd IS that repo.
  const row: RequestRow = {
    requestId: 'r1', sessionId: null, tsEpochMs: Date.now(), provider: 'anthropic', model: 'claude-opus-4-8',
    project: 'metered-proj', taskWeight: 1, inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.5, estimated: false, streamed: false, statusCode: 200, durationMs: 10,
    source: 'claude-code', cwd: withSpend,
  };
  store.insertRequest(row);

  const plan = planScan(store, { roots: [root] });
  assert.equal(plan.repos.length, 2, 'both repos discovered');
  assert.ok(plan.reposWithSpend.includes(withSpend), 'the repo with recorded spend is RoI-ready');
  assert.equal(plan.reposWithSpend.length, 1);
  assert.equal(plan.reposUnmetered.length, 1, 'the fresh repo needs an import');
  assert.equal(plan.knownProjects, 1);
  store.close();
});

test('planScan: honest empty — no repos under an empty root, no crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-empty-'));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'scan-store2-')), 'test.db'));
  const plan = planScan(store, { roots: [root] });
  assert.deepEqual(plan.repos, []);
  assert.deepEqual(plan.reposWithSpend, []);
  assert.equal(plan.tools.length, 3, 'tools are still detected even with no repos');
  store.close();
});

/** Build a minimal ScanPlan for the pure diff tests (only roots/repos/tools matter to diffScan). */
function mkPlan(roots: string[], repos: string[], presentToolIds: string[]): ScanPlan {
  return {
    tools: presentToolIds.map((id) => ({ id, label: id, present: true, dataPath: '/x', blurb: '' })),
    roots,
    repos,
    scan: { repos, roots, dirsVisited: 0, hitBudget: false },
    knownProjects: 0,
    reposWithSpend: [],
    reposUnmetered: repos,
  };
}

test('diffScan: a first scan (no prior snapshot) is not comparable', () => {
  const d = diffScan(null, mkPlan(['A'], ['r1'], ['codex']));
  assert.equal(d.comparable, false);
  assert.deepEqual([d.newRepos, d.newTools, d.goneRepos], [[], [], []]);
});

test('diffScan: same roots — reports new repos, gone repos, and newly-present tools', () => {
  const prev: ScanSnapshot = { rootsKey: 'A', repos: ['r1', 'r2'], toolIds: ['claude-code'], atMs: 1000 };
  const d = diffScan(prev, mkPlan(['A'], ['r2', 'r3'], ['claude-code', 'codex']));
  assert.equal(d.comparable, true);
  assert.equal(d.sinceMs, 1000);
  assert.deepEqual(d.newRepos, ['r3'], 'r3 is new');
  assert.deepEqual(d.goneRepos, ['r1'], 'r1 disappeared');
  assert.deepEqual(d.newTools, ['codex'], 'codex is newly present');
});

test('diffScan: a snapshot of DIFFERENT roots is not a valid comparison', () => {
  const prev: ScanSnapshot = { rootsKey: 'A', repos: ['r1'], toolIds: [], atMs: 1000 };
  const d = diffScan(prev, mkPlan(['B'], ['r9'], []));
  assert.equal(d.comparable, false, 'diffing different folders would report noise, not real change');
});

test('scanWithDiff + saveScan: a re-scan of the same roots diffs against the saved baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-diff-'));
  makeRepo(dir(root, 'p1'));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'scan-diff-store-')), 'test.db'));

  const first = scanWithDiff(store, { roots: [root] });
  assert.equal(first.diff.comparable, false, 'nothing to compare on the first scan');
  saveScan(store, first.plan);

  // A new repo appears; the re-scan must flag exactly it.
  makeRepo(dir(root, 'p2'));
  const second = scanWithDiff(store, { roots: [root] });
  assert.equal(second.diff.comparable, true, 'the saved baseline makes the re-scan comparable');
  assert.equal(second.diff.newRepos.length, 1);
  assert.ok(second.diff.newRepos[0]!.includes('p2'), 'the added repo is the reported change');
  saveScan(store, second.plan);

  // No change → an empty, still-comparable diff.
  const third = scanWithDiff(store, { roots: [root] });
  assert.equal(third.diff.comparable, true);
  assert.deepEqual([third.diff.newRepos, third.diff.goneRepos], [[], []], 'no churn → no changes');
  store.close();
});

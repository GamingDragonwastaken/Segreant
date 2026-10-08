/**
 * Auto-correlation — imported projects → per-project RoI with NO --repo and NO
 * wiring. Captured working directories map each project to its git repo AND to the
 * tools that coded it (repo↔project↔tool); discovery realizes the projects that are
 * real repos, scopes each to its own spend, and skips the rest honestly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { projectName } from '../src/git/correlate.ts';
import { discoverProjectRepos, realizeDiscoveredProjects, projectValueBreakdown } from '../src/value/realization.ts';

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'segreant-disc-'));
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
function row(project: string, cwd: string | null, source: string | null, tsIso: string, costUsd: number, id: string): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: Date.parse(tsIso), provider: 'anthropic', model: 'claude-opus-4-8',
    project, taskWeight: 1, inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 10, source, cwd,
  };
}

test('projectPaths: maps each project to its modal cwd and the tools that coded it', () => {
  const store = new Store(':memory:');
  try {
    const t = '2026-06-01T10:30:00Z';
    store.insertRequest(row('game', '/home/dev/game', 'claude-code', t, 0.5, 'a'));
    store.insertRequest(row('game', '/home/dev/game', 'codex', t, 0.3, 'b'));
    store.insertRequest(row('game', '/tmp/weird-once', 'claude-code', t, 0.1, 'c')); // a one-off subdir
    store.insertRequest(row('api', '/home/dev/api', 'opencode', t, 2.0, 'd'));
    store.insertRequest(row('untagged', null, null, t, 5.0, 'e')); // no cwd → excluded

    const paths = store.projectPaths();
    assert.equal(paths.length, 2, 'only projects with a cwd participate');
    const game = paths.find((p) => p.project === 'game')!;
    assert.equal(game.cwd, '/home/dev/game', 'the modal cwd wins over a one-off subdir');
    assert.deepEqual(game.sources, ['claude-code', 'codex']);
    assert.ok(Math.abs(game.costUsd - 0.9) < 1e-9);
    assert.deepEqual(paths.find((p) => p.project === 'api')!.sources, ['opencode']);
    assert.equal(paths[0]!.project, 'api', 'sorted by cost desc (api 2.0 > game 0.9)');
  } finally {
    store.close();
  }
});

test('discoverProjectRepos: keeps real git repos, skips non-repos', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    const project = await projectName(dir);
    store.insertRequest(row(project, dir, 'claude-code', '2026-06-01T09:30:00Z', 0.5, 'a'));
    store.insertRequest(row('ghost', join(tmpdir(), 'definitely-not-here-xyz-123'), 'codex', '2026-06-01T09:30:00Z', 0.4, 'b'));

    const repos = await discoverProjectRepos(store);
    assert.equal(repos.length, 1, 'the non-existent path is skipped, never guessed');
    assert.equal(repos[0]!.project, project);
    assert.equal(repos[0]!.repoPath, dir);
    assert.deepEqual(repos[0]!.sources, ['claude-code']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('realizeDiscoveredProjects: imported spend → per-project RoI with no --repo, scoped + tool-linked', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'feat: more', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);
    // This project's imported spend, plus a noisy OTHER project in the same window.
    store.insertRequest(row(project, dir, 'claude-code', '2026-06-01T10:30:00Z', 0.5, 'mine'));
    store.insertRequest(row('other', '/somewhere/other', 'codex', '2026-06-01T10:31:00Z', 9.9, 'theirs'));

    const results = await realizeDiscoveredProjects(store, { windowDays: 14 });
    assert.equal(results.length, 1, 'only the real repo is correlated');
    assert.equal(results[0]!.project, project);
    assert.ok(results[0]!.units >= 1);

    // Per-project value is now persisted (no --repo was ever passed) and carries the tool link.
    const projects = projectValueBreakdown(store);
    const pv = projects.find((p) => p.project === project)!;
    assert.ok(pv, 'the discovered project has value');
    assert.deepEqual(pv.sources, ['claude-code'], 'the project knows which tool coded it');
    assert.ok(pv.costUsd < 1, `project-scoped cost should be its own ~$0.50, not the $9.9 next door (got ${pv.costUsd})`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('realizeDiscoveredProjects: honest no-op when no working directory was captured', async () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(row('default', null, null, '2026-06-01T10:30:00Z', 1.0, 'x')); // e.g. untagged proxy / demo
    const results = await realizeDiscoveredProjects(store);
    assert.equal(results.length, 0);
  } finally {
    store.close();
  }
});

test('realizeDiscoveredProjects: a shared stage deadline goes largest spend first and never reports an unreached repo as zero', async () => {
  const small = makeRepo();
  const large = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(small, 'a.txt', 'one\n', 'feat: small', '2026-06-01T10:00:00+00:00');
    commit(large, 'a.txt', 'one\n', 'feat: large', '2026-06-01T10:00:00+00:00');
    store.insertRequest(row(await projectName(small), small, 'claude-code', '2026-06-01T09:30:00Z', 0.5, 's'));
    store.insertRequest(row(await projectName(large), large, 'codex', '2026-06-01T09:30:00Z', 5, 'l'));

    const none = await realizeDiscoveredProjects(store, { windowDays: 14, stageBudgetMs: 0 });
    assert.deepEqual(none.map((r) => r.repoPath), [large, small], 'largest spend first');
    assert.ok(none.every((r) => !r.measured && r.kept === undefined), 'nothing reached is reported as not measured');

    const all = await realizeDiscoveredProjects(store, { windowDays: 14, stageBudgetMs: 60_000 });
    assert.ok(all.every((r) => r.measured && r.kept !== undefined));
    assert.equal(all[0]!.kept!.kept.units + all[0]!.kept!.notKept.units + all[0]!.kept!.unknown.units, 1,
      'the matured commit has a verdict bucket');
  } finally {
    store.close();
    rmSync(small, { recursive: true, force: true });
    rmSync(large, { recursive: true, force: true });
  }
});

test('realizeDiscoveredProjects: clones of one repository are measured once, on the newest checkout', async () => {
  const origin = makeRepo();
  const cloneDir = mkdtempSync(join(tmpdir(), 'segreant-disc-clone-'));
  const store = new Store(':memory:');
  try {
    commit(origin, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    execFileSync('git', ['clone', '-q', origin, join(cloneDir, 'copy')], { stdio: 'ignore' });
    const copy = join(cloneDir, 'copy');
    commit(origin, 'a.txt', 'one\ntwo\n', 'feat: newer', '2026-06-02T10:00:00+00:00');
    store.insertRequest(row(await projectName(origin), origin, 'claude-code', '2026-06-01T09:30:00Z', 1, 'o'));
    store.insertRequest(row(await projectName(copy), copy, 'codex', '2026-06-01T09:31:00Z', 2, 'c'));

    const results = await realizeDiscoveredProjects(store, { windowDays: 14 });
    assert.equal(results.length, 1, 'one repository, not one per checkout');
    assert.equal(results[0]!.repoPath, origin, 'the checkout with the newest HEAD');
    assert.deepEqual(results[0]!.otherCheckouts, [copy]);
    assert.deepEqual(results[0]!.sources, ['claude-code', 'codex']);
  } finally {
    store.close();
    rmSync(origin, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

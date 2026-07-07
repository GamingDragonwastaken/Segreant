/**
 * The RoI bridge — native, no-proxy imported spend flowing into per-project RoI.
 *
 * The mechanic: attribution scopes a commit's window to the commit's PROJECT when
 * the ledger is characterized by project (imports, or tagged proxy), so a commit
 * absorbs only its own project's spend — not every project's concurrent traffic.
 * When the ledger is project-blind ('default' proxy), it falls back to the
 * window-wide sum, unchanged. Both paths are asserted here, plus the store-level
 * primitives that back them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { attributeCommits, projectName } from '../src/git/correlate.ts';
import { computeRealization } from '../src/value/realization.ts';

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-bridge-'));
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

/** A minimal imported-style request row (source-tagged, no proxy) at a given time. */
function importedRow(project: string, source: string, tsIso: string, costUsd: number, id: string): RequestRow {
  return {
    requestId: id,
    sessionId: null,
    tsEpochMs: Date.parse(tsIso),
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    project,
    taskWeight: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 10,
    source,
  };
}

test('store: summary scopes to a project, hasProjectSpend gates, characterization groups', () => {
  const store = new Store(':memory:');
  try {
    const t = '2026-06-01T10:30:00Z';
    store.insertRequest(importedRow('game', 'claude-code', t, 0.5, 'a'));
    store.insertRequest(importedRow('game', 'claude-code', t, 0.25, 'b'));
    store.insertRequest(importedRow('aegisflow', 'codex', t, 9.0, 'c'));

    const start = Date.parse('2026-06-01T00:00:00Z');
    const end = Date.parse('2026-06-02T00:00:00Z');

    // project-blind total vs project-scoped
    assert.ok(Math.abs(store.summary(start, end).costUsd - 9.75) < 1e-9);
    assert.ok(Math.abs(store.summary(start, end, 'game').costUsd - 0.75) < 1e-9);
    assert.equal(store.summary(start, end, 'game').requests, 2);
    assert.ok(Math.abs(store.summary(start, end, 'aegisflow').costUsd - 9.0) < 1e-9);
    assert.equal(store.summary(start, end, 'nonexistent').costUsd, 0);

    // the gate that decides whether scoping is meaningful
    assert.equal(store.hasProjectSpend('game'), true);
    assert.equal(store.hasProjectSpend('aegisflow'), true);
    assert.equal(store.hasProjectSpend('default'), false);

    // the typed characterization section
    const ch = store.characterization(start, end);
    assert.deepEqual(ch.byProject.map((b) => b.label).sort(), ['aegisflow', 'game']);
    assert.deepEqual(ch.bySource.map((b) => b.label).sort(), ['claude-code', 'codex']);
    assert.equal(ch.byModel.length, 1);
    assert.equal(ch.byModel[0]!.provider, 'anthropic');
  } finally {
    store.close();
  }
});

test('attributeCommits: scoped to project absorbs only that project\'s window spend', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'feat: more', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir); // the repo's canonical key

    // Same window [10:00, 11:00): this project's imported spend + an unrelated project's.
    store.insertRequest(importedRow(project, 'claude-code', '2026-06-01T10:30:00Z', 0.5, 'mine'));
    store.insertRequest(importedRow('other-project', 'codex', '2026-06-01T10:31:00Z', 9.99, 'theirs'));

    const scoped = await attributeCommits(store, dir, { limit: 5, scopeProject: project });
    const more = scoped.find((r) => r.subject === 'feat: more')!;
    assert.ok(Math.abs(more.attributedCostUsd - 0.5) < 1e-9, `scoped got ${more.attributedCostUsd}, expected 0.5`);
    assert.equal(more.attributedRequests, 1);

    // Without scoping (the proxy default), the same commit absorbs BOTH projects.
    const blind = await attributeCommits(store, dir, { limit: 5 });
    const moreBlind = blind.find((r) => r.subject === 'feat: more')!;
    assert.ok(Math.abs(moreBlind.attributedCostUsd - 10.49) < 1e-9, `blind got ${moreBlind.attributedCostUsd}, expected 10.49`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeRealization: imported spend tagged with the project auto-scopes (projectScoped=true)', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'feat: more', '2026-06-01T11:00:00+00:00');
    const project = await projectName(dir);

    // Native import: this project's spend, plus a noisy other project in the same window.
    store.insertRequest(importedRow(project, 'claude-code', '2026-06-01T10:30:00Z', 0.5, 'mine'));
    store.insertRequest(importedRow('other-project', 'codex', '2026-06-01T10:31:00Z', 9.99, 'theirs'));

    const rep = await computeRealization(store, dir, { limit: 5, windowDays: 14 });
    assert.equal(rep.projectScoped, true, 'the ledger IS characterized by this project → scoped');
    const more = rep.units.find((u) => u.subject === 'feat: more')!;
    assert.ok(Math.abs(more.attributedCostUsd - 0.5) < 1e-9, `expected only this project's $0.50, got ${more.attributedCostUsd}`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeRealization: a project-blind ledger falls back to window-wide (projectScoped=false)', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'a.txt', 'one\n', 'feat: base', '2026-06-01T10:00:00+00:00');
    commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'feat: more', '2026-06-01T11:00:00+00:00');

    // Only 'default'-tagged proxy spend — the repo's project key does NOT appear.
    store.insertRequest(importedRow('default', 'direct', '2026-06-01T10:30:00Z', 4.2, 'p1'));

    const rep = await computeRealization(store, dir, { limit: 5, windowDays: 14 });
    assert.equal(rep.projectScoped, false, 'no project-tagged spend → window-wide fallback, unchanged');
    const more = rep.units.find((u) => u.subject === 'feat: more')!;
    assert.ok(Math.abs(more.attributedCostUsd - 4.2) < 1e-9, `expected window-wide $4.20, got ${more.attributedCostUsd}`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

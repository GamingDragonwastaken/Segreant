import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: 1000, provider: 'anthropic',
    model: 'm', project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1, estimated: false, streamed: false, statusCode: 200,
    durationMs: 1, ...over,
  };
}

test('store.byUser: groups spend by developer; null reads as "unassigned", sorted by cost', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ user: 'alice', costUsd: 3 }));
  store.insertRequest(req({ user: 'alice', costUsd: 2 }));
  store.insertRequest(req({ user: 'bob', costUsd: 1 }));
  store.insertRequest(req({ user: null, costUsd: 4 }));
  const rows = store.byUser(0, 5000);
  const map = Object.fromEntries(rows.map((r) => [r.label, r.costUsd]));
  assert.equal(map['alice'], 5);
  assert.equal(map['bob'], 1);
  assert.equal(map['unassigned'], 4);
  assert.equal(rows[0]!.label, 'alice'); // highest cost first (alice $5 > unassigned $4 > bob $1)
  store.close();
});

test('store.bySource: groups spend by connected source; null reads as "direct", sorted by cost', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ source: 'opencode', costUsd: 3 }));
  store.insertRequest(req({ source: 'opencode', costUsd: 2 }));
  store.insertRequest(req({ source: 'cursor', costUsd: 1 }));
  store.insertRequest(req({ source: null, costUsd: 4 }));
  const rows = store.bySource(0, 5000);
  const map = Object.fromEntries(rows.map((r) => [r.label, r.costUsd]));
  assert.equal(map['opencode'], 5);
  assert.equal(map['cursor'], 1);
  assert.equal(map['direct'], 4);
  assert.equal(rows[0]!.label, 'opencode'); // highest cost first (opencode $5 > direct $4 > cursor $1)
  store.close();
});

test('store.bySourceWithDepth: depth is read from real signals (proposals → acceptance, realized project → RoI)', () => {
  const store = new Store(':memory:');
  // opencode: a coding session with a SESSION-LINKED proposal (request_id null) → acceptance.
  store.insertRequest(req({ source: 'opencode', sessionId: 's1', project: 'pA', costUsd: 3 }));
  store.insertProposal({
    proposalId: 'pr1', requestId: null, sessionId: 's1', tsEpochMs: 1000,
    provider: 'anthropic', model: 'm', project: 'pA', files: [{ path: 'a.ts', addedLines: ['x'] }],
  });
  // cursor: no proposals, but its work is in a project that has realized-value snapshots → RoI.
  store.insertRequest(req({ source: 'cursor', sessionId: null, project: 'pRealized', costUsd: 2 }));
  store.saveRealizationUnits([{
    commitHash: 'c1', project: 'pRealized', tsEpochMs: 1000, computedAtMs: 1000,
    attributedCostUsd: 1, maturing: false, realized: true, unitJson: '{}', costScope: 'project',
  }]);
  // direct: untagged traffic, spend only.
  store.insertRequest(req({ source: null, sessionId: null, project: 'pA', costUsd: 1 }));

  const rows = store.bySourceWithDepth(0, 5000);
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.deepEqual(
    { tagged: by['opencode']!.tagged, hasProposals: by['opencode']!.hasProposals, hasOutcomes: by['opencode']!.hasOutcomes },
    { tagged: true, hasProposals: true, hasOutcomes: false },
  );
  assert.deepEqual(
    { tagged: by['cursor']!.tagged, hasProposals: by['cursor']!.hasProposals, hasOutcomes: by['cursor']!.hasOutcomes },
    { tagged: true, hasProposals: false, hasOutcomes: true },
  );
  assert.equal(by['direct']!.tagged, false);
  assert.equal(by['direct']!.hasProposals, false);
  store.close();
});

test('store.sourceModelBreakdown: groups model spend within each source (Source→Model)', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ source: 'opencode', provider: 'anthropic', model: 'opus', costUsd: 5 }));
  store.insertRequest(req({ source: 'opencode', provider: 'anthropic', model: 'sonnet', costUsd: 2 }));
  store.insertRequest(req({ source: 'opencode', provider: 'anthropic', model: 'opus', costUsd: 3 }));
  store.insertRequest(req({ source: 'cursor', provider: 'openai', model: 'gpt-4o', costUsd: 1 }));
  const rows = store.sourceModelBreakdown(0, 5000);
  const opencode = rows.filter((r) => r.source === 'opencode');
  assert.equal(opencode[0]!.model, 'opus'); // cost-descending within the source
  assert.equal(opencode[0]!.costUsd, 8); // 5 + 3 merged into one model row
  assert.equal(opencode[0]!.requests, 2);
  const cursor = rows.filter((r) => r.source === 'cursor');
  assert.equal(cursor.length, 1);
  assert.equal(cursor[0]!.model, 'gpt-4o');
  store.close();
});

test('store migration: a DB created before the user column gains it (ALTER path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-mig-'));
  const path = join(dir, 'old.db');
  try {
    // Simulate a pre-`user` database: the original requests schema, no user column.
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        `CREATE TABLE requests (
          request_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, ts_iso TEXT NOT NULL, ts_epoch_ms INTEGER NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'default', task_weight REAL NOT NULL DEFAULT 1.0,
          input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0, streamed INTEGER NOT NULL DEFAULT 0, status_code INTEGER, duration_ms INTEGER)`,
      )
      .run();
    raw.close();

    // Opening via Store runs migrate(), which must ALTER ADD COLUMN both `user`
    // and `source` — a real DB created before either column existed.
    const store = new Store(path);
    store.insertRequest(req({ user: 'alice', source: 'opencode', costUsd: 2 }));
    assert.equal(store.byUser(0, 5000)[0]!.label, 'alice');
    assert.equal(store.bySource(0, 5000)[0]!.label, 'opencode'); // source column was added

    // Idempotent: re-opening the now-migrated DB must not throw, and both columns persist.
    store.close();
    const again = new Store(path);
    assert.equal(again.byUser(0, 5000)[0]!.label, 'alice');
    assert.equal(again.bySource(0, 5000)[0]!.label, 'opencode');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Project aliasing: merges labels at query time, never rewrites rows ----

test('project aliases: byProject rolls aliased labels into the canonical; raw rows untouched', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ project: 'fiscus', costUsd: 3 }));
  store.insertRequest(req({ project: 'fiscus-ts', costUsd: 2 }));
  store.insertRequest(req({ project: 'other', costUsd: 1 }));

  store.setProjectAlias('fiscus-ts', 'fiscus');
  const rows = store.byProject(0, 5000);
  const map = Object.fromEntries(rows.map((r) => [r.label, r.costUsd]));
  assert.equal(map['fiscus'], 5); // merged
  assert.equal(map['other'], 1);
  assert.equal(map['fiscus-ts'], undefined);

  // Reversible: unalias restores the original split (raw rows were never rewritten).
  store.removeProjectAlias('fiscus-ts');
  const split = Object.fromEntries(store.byProject(0, 5000).map((r) => [r.label, r.costUsd]));
  assert.equal(split['fiscus'], 3);
  assert.equal(split['fiscus-ts'], 2);
  store.close();
});

test('project aliases: summary/hasProjectSpend match the whole family under either name', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ project: 'fiscus', costUsd: 3 }));
  store.insertRequest(req({ project: 'fiscus-ts', costUsd: 2 }));
  store.setProjectAlias('fiscus-ts', 'fiscus');

  assert.equal(store.summary(0, 5000, 'fiscus').costUsd, 5);
  assert.equal(store.summary(0, 5000, 'fiscus-ts').costUsd, 5); // alias resolves to same family
  assert.equal(store.hasProjectSpend('fiscus-ts'), true);
  assert.deepEqual(store.projectFamily('fiscus-ts').sort(), ['fiscus', 'fiscus-ts']);
  store.close();
});

test('project aliases: mapping stays flat — chaining re-points, self-alias throws', () => {
  const store = new Store(':memory:');
  store.setProjectAlias('b', 'a'); // b → a
  store.setProjectAlias('c', 'b'); // c → b must flatten to c → a
  assert.equal(store.canonicalProject('c'), 'a');

  // Re-pointing a former canonical drags its aliases along: a → z means b,c → z too.
  store.setProjectAlias('a', 'z');
  assert.equal(store.canonicalProject('b'), 'z');
  assert.equal(store.canonicalProject('c'), 'z');

  assert.throws(() => store.setProjectAlias('x', 'x'));
  // Aliasing to a name that resolves back to yourself is also a self-alias.
  assert.throws(() => store.setProjectAlias('z', 'b'));
  store.close();
});

test('project aliases: realization units and projects list follow the canonical label', () => {
  const store = new Store(':memory:');
  store.saveRealizationUnits([
    { commitHash: 'c1', project: 'fiscus', tsEpochMs: 1000, computedAtMs: 1000, attributedCostUsd: 1, maturing: false, realized: true, unitJson: '{}', costScope: 'project' },
    { commitHash: 'c2', project: 'fiscus-ts', tsEpochMs: 2000, computedAtMs: 2000, attributedCostUsd: 2, maturing: false, realized: false, unitJson: '{}', costScope: 'project' },
  ]);
  store.setProjectAlias('fiscus-ts', 'fiscus');
  assert.equal(store.countRealizationUnits('fiscus'), 2);
  assert.equal(store.realizationUnitRows('fiscus-ts').length, 2);
  assert.deepEqual(store.realizationProjects(), ['fiscus']);
  store.close();
});

test('store.sessionsInWindow: real sessions only, newest activity first, tool from the sessions table, aliases folded', () => {
  const store = new Store(':memory:');
  // Session s1 (claude-code, project fiscus): two requests.
  store.upsertSession('s1', 'fiscus', 'claude-code', 1000);
  store.insertRequest(req({ sessionId: 's1', project: 'fiscus', tsEpochMs: 1000, costUsd: 1 }));
  store.insertRequest(req({ sessionId: 's1', project: 'fiscus', tsEpochMs: 2000, costUsd: 2 }));
  // Session s2 under the ALIASED name, never upserted into sessions → tool 'unknown'.
  store.insertRequest(req({ sessionId: 's2', project: 'fiscus-ts', tsEpochMs: 3000, costUsd: 4 }));
  // Sessionless request: must not appear at all.
  store.insertRequest(req({ sessionId: null, project: 'fiscus', tsEpochMs: 2500, costUsd: 8 }));
  // Out-of-window activity: excluded.
  store.insertRequest(req({ sessionId: 's3', project: 'fiscus', tsEpochMs: 99_000, costUsd: 16 }));
  store.setProjectAlias('fiscus-ts', 'fiscus');

  const rows = store.sessionsInWindow('fiscus', 0, 5000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, 's2'); // newest activity first
  assert.equal(rows[0]!.tool, 'unknown');
  assert.equal(rows[0]!.costUsd, 4);
  assert.equal(rows[1]!.sessionId, 's1');
  assert.equal(rows[1]!.tool, 'claude-code');
  assert.equal(rows[1]!.requestCount, 2);
  assert.equal(rows[1]!.costUsd, 3);

  assert.deepEqual(store.getSessionMeta('s1'), { project: 'fiscus', tool: 'claude-code', startMs: 1000 });
  assert.equal(store.getSessionMeta('nope'), null);
  store.close();
});

test('store.pruneProposals: removes only proposal rows older than the cutoff', () => {
  const store = new Store(':memory:');
  store.insertProposal({
    proposalId: 'p-old', requestId: 'r-old', sessionId: null, tsEpochMs: 1000,
    provider: 'anthropic', model: 'claude-3', project: 'demo', files: [{ path: 'a.ts', addedLines: ['const x = 1;'] }],
  });
  store.insertProposal({
    proposalId: 'p-new', requestId: 'r-new', sessionId: null, tsEpochMs: 9000,
    provider: 'anthropic', model: 'claude-3', project: 'demo', files: [{ path: 'b.ts', addedLines: ['const y = 2;'] }],
  });
  const removed = store.pruneProposals(5000);
  assert.equal(removed, 1);
  const remaining = store.proposalsInWindow('demo', 0, 10_000);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.proposalId, 'p-new');
  store.close();
});

test('store.clearProposals: removes every proposal row regardless of age', () => {
  const store = new Store(':memory:');
  store.insertProposal({
    proposalId: 'p-1', requestId: 'r-1', sessionId: null, tsEpochMs: Date.now(),
    provider: 'anthropic', model: 'claude-3', project: 'demo', files: [{ path: 'a.ts', addedLines: ['x'] }],
  });
  const removed = store.clearProposals();
  assert.equal(removed, 1);
  assert.equal(store.proposalsInWindow('demo', 0, Date.now() + 1000).length, 0);
  store.close();
});

test('store.recentProviderConnections: groups requests by provider+model within the window, newest first', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ provider: 'anthropic', model: 'claude-3', tsEpochMs: 1000 }));
  store.insertRequest(req({ provider: 'anthropic', model: 'claude-3', tsEpochMs: 2000 }));
  store.insertRequest(req({ provider: 'openai', model: 'gpt-4o', tsEpochMs: 3000 }));
  store.insertRequest(req({ provider: 'anthropic', model: 'claude-3', tsEpochMs: 100 })); // outside window below
  const conns = store.recentProviderConnections(500);
  const anthropic = conns.find((c) => c.provider === 'anthropic' && c.model === 'claude-3');
  const openai = conns.find((c) => c.provider === 'openai');
  assert.ok(anthropic);
  assert.equal(anthropic!.requestCount, 2); // the ts=100 row is excluded by the sinceMs cutoff
  assert.equal(anthropic!.lastSeenMs, 2000);
  assert.ok(openai);
  assert.equal(conns[0]!.provider, 'openai'); // newest lastSeenMs first
  store.close();
});

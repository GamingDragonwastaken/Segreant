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
    attributedCostUsd: 1, maturing: false, realized: true, unitJson: '{}',
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

test('store migration: a DB created before the user column gains it (ALTER path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-mig-'));
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

    // Opening via Store runs migrate(), which must ALTER ADD COLUMN user.
    const store = new Store(path);
    store.insertRequest(req({ user: 'alice', costUsd: 2 }));
    const rows = store.byUser(0, 5000);
    assert.equal(rows[0]!.label, 'alice');

    // Idempotent: re-opening the now-migrated DB must not throw.
    store.close();
    const again = new Store(path);
    assert.equal(again.byUser(0, 5000)[0]!.label, 'alice');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

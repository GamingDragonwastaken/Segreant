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

/**
 * A MIGRATION INTERRUPTED AT ANY STATEMENT LEAVES THE DATABASE EXACTLY AS IT
 * FOUND IT, AND THE NEXT OPEN COMPLETES IT.
 *
 * WP-H01/H04 left "migration-interruption coverage" open: `initializeSchema`
 * runs the schema, the kernel and economic schemas, the guarded migrations
 * and the immutability triggers inside one `BEGIN IMMEDIATE` and rolls back
 * on any error, but nothing had ever thrown from inside it to see whether
 * that held. This injects a fault at the N-th DDL statement — for a sweep of
 * N across the migration — against a legacy two-table database, and checks
 * three things after each: the user_version is still the legacy one, the
 * table set is exactly the legacy pair (no half-created table survives), and
 * the legacy row is intact. Then a clean open must migrate completely.
 *
 * The fault is injected by shadowing `prepare` on the connection instance;
 * nothing in the store is changed to admit it. The full migration issues 154
 * DDL statements at the time of writing; the sweep takes seven points across
 * them. Shown able to fail: with the BEGIN/COMMIT removed from
 * `initializeSchema` the table-set assertion fails at sweep point 42 (the two
 * earliest points create nothing yet). Recorded at D-233.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema, CURRENT_SCHEMA_VERSION } from '../src/store/schema.ts';
import { Store } from '../src/store/db.ts';

const LEGACY_TABLES = ['requests', 'sessions'];

function writeLegacy(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.prepare(`CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL DEFAULT 'default', tool TEXT NOT NULL DEFAULT 'unknown',
    start_ms INTEGER NOT NULL, end_ms INTEGER, status TEXT NOT NULL DEFAULT 'active'
  )`).run();
  legacy.prepare(`CREATE TABLE requests (
    request_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, ts_iso TEXT NOT NULL, ts_epoch_ms INTEGER NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'default', task_weight REAL NOT NULL DEFAULT 1.0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0, streamed INTEGER NOT NULL DEFAULT 0, status_code INTEGER, duration_ms INTEGER
  )`).run();
  legacy.prepare('INSERT INTO sessions (session_id, start_ms) VALUES (?, ?)').run('legacy-session', 1_700_000_000_000);
  legacy.prepare(`INSERT INTO requests (
    request_id, session_id, ts_iso, ts_epoch_ms, provider, model, project, task_weight, input_tokens, output_tokens,
    cache_write_tokens, cache_read_tokens, reasoning_tokens, cost_usd, estimated, streamed, status_code, duration_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-request', 'legacy-session', '2023-11-14T22:13:20.000Z', 1_700_000_000_000,
    'openai', 'gpt-4o', 'legacy-project', 1, 10, 5, 0, 0, 0, 0.00125, 0, 0, 200, 12,
  );
  legacy.close();
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

const DDL = /^\s*(CREATE|ALTER|DROP)\b/i;

/** Count the DDL statements a full migration issues, so the sweep covers the whole of it. */
function ddlStatementCount(path: string): number {
  const db = new DatabaseSync(path);
  const original = db.prepare.bind(db);
  let count = 0;
  db.prepare = ((sql: string) => { if (DDL.test(sql)) count += 1; return original(sql); }) as typeof db.prepare;
  initializeSchema(db, { allowUnbackedCausalV2Create: true });
  db.close();
  return count;
}

function interruptAt(path: string, faultAt: number): Error {
  const db = new DatabaseSync(path);
  const original = db.prepare.bind(db);
  let seen = 0;
  db.prepare = ((sql: string) => {
    if (DDL.test(sql)) {
      seen += 1;
      if (seen === faultAt) throw new Error(`injected fault at DDL statement ${faultAt}`);
    }
    return original(sql);
  }) as typeof db.prepare;
  let thrown: Error | null = null;
  try {
    initializeSchema(db, { allowUnbackedCausalV2Create: true });
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  } finally {
    db.close();
  }
  assert.ok(thrown, `the injected fault at ${faultAt} must surface`);
  return thrown;
}

test('a migration interrupted at any DDL statement rolls back to the legacy schema, and the next open completes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-migration-interruption-'));
  try {
    const probe = join(dir, 'probe.sqlite');
    writeLegacy(probe);
    const total = ddlStatementCount(probe);
    assert.ok(total >= 20, `the migration must issue enough DDL for a sweep to mean anything (saw ${total})`);

    // A sweep across the migration: the first statement, several interior
    // points, and the last one.
    const points = [...new Set([1, 2, Math.floor(total / 4), Math.floor(total / 2), Math.floor((3 * total) / 4), total - 1, total])];
    for (const faultAt of points) {
      const path = join(dir, `legacy-${faultAt}.sqlite`);
      writeLegacy(path);
      const thrown = interruptAt(path, faultAt);
      assert.match(thrown.message, /injected fault/, `the store must not swallow the fault at ${faultAt}`);

      const check = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(userVersion(check), 0, `user_version must stay legacy after a fault at ${faultAt}`);
        assert.deepEqual(tables(check), LEGACY_TABLES, `no half-created table may survive a fault at ${faultAt}`);
        assert.equal((check.prepare("SELECT COUNT(*) AS n FROM requests WHERE request_id = 'legacy-request'").get() as { n: number }).n, 1);
      } finally {
        check.close();
      }

      const migrated = new Store(path);
      try {
        assert.equal(userVersion(migrated.raw()), CURRENT_SCHEMA_VERSION, `a clean open after the fault at ${faultAt} must complete the migration`);
        assert.equal(migrated.requestsInRange(0, 2_000_000_000_000).length, 1, 'the legacy row survives the completed migration');
      } finally {
        migrated.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import {
  assertDatabaseIntegrity,
  assertDatabasePragmas,
  configureDatabaseConnection,
  databasePragmas,
} from '../src/store/schema.ts';

async function removeTestDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function expectReloadFailure(dbPath: string, triggerName: string, expectedSql?: RegExp): void {
  let reopened: Store | null = null;
  let failure: unknown;
  try {
    reopened = new Store(dbPath);
  } catch (error) {
    failure = error;
  } finally {
    reopened?.close();
  }
  assert.ok(failure instanceof Error, 'tampered Store reload must fail closed');
  assert.match(failure.message, /^CAUSAL_IO_FAILURE:/);

  const retained = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const trigger = retained.prepare(
      'SELECT sql FROM sqlite_master WHERE type = \'trigger\' AND name = ?',
    ).get(triggerName) as { sql: string | null } | undefined;
    if (expectedSql) {
      assert.match(trigger?.sql ?? '', expectedSql);
    } else {
      assert.equal(trigger, undefined, `failed reload must not repair ${triggerName}`);
    }
  } finally {
    retained.close();
  }
}

test('connection configuration enables the contention and trigger safeguards', () => {
  const db = new DatabaseSync(':memory:');
  try {
    configureDatabaseConnection(db);
    const state = databasePragmas(db);
    assert.equal(state.foreignKeys, 1);
    assert.equal(state.recursiveTriggers, 1);
    assert.equal(state.busyTimeout, 5_000);
    assert.equal(state.journalMode, 'memory');
    assert.equal(state.synchronous, 2, 'a raw connection has not selected NORMAL yet');
    db.prepare('PRAGMA synchronous = NORMAL').run();
    assertDatabasePragmas(db);
  } finally {
    db.close();
  }
});

test('database integrity inspection rejects a direct-write foreign-key violation', () => {
  const store = new Store(':memory:');
  try {
    store.raw().prepare('PRAGMA foreign_keys = OFF').run();
    store.raw().prepare(
      'INSERT INTO economic_event_sources (event_id, source_event_id) VALUES (?, ?)',
    ).run('forged-child', 'missing-parent');
    assert.throws(
      () => assertDatabaseIntegrity(store.raw()),
      /foreign[_ ]key|integrity/i,
    );
  } finally {
    store.close();
  }
});

test('Store reload fails closed when an epistemic append-only trigger is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-epistemic-'));
  const dbPath = join(dir, 'ledger.sqlite');
  let seeded: Store | null = null;
  try {
    seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER epistemic_nodes_append_only_update').run();
    seeded.close();
    seeded = null;

    expectReloadFailure(dbPath, 'epistemic_nodes_append_only_update');
  } finally {
    seeded?.close();
    await removeTestDirectory(dir);
  }
});

test('backup refuses to publish a snapshot after an append-only trigger is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-backup-'));
  const dbPath = join(dir, 'ledger.sqlite');
  const backupPath = join(dir, 'backup.sqlite');
  let seeded: Store | null = null;
  try {
    seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_allocation_lineage_append_only_delete').run();
    const result = seeded.backupTo(backupPath);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /append-only|trigger|integrity/i);
    assert.equal(existsSync(backupPath), false);
  } finally {
    seeded?.close();
    await removeTestDirectory(dir);
  }
});

test('Store reload fails closed when an economic append-only trigger is deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-economic-'));
  const dbPath = join(dir, 'ledger.sqlite');
  let seeded: Store | null = null;
  try {
    seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_events_append_only_update').run();
    seeded.close();
    seeded = null;

    expectReloadFailure(dbPath, 'economic_events_append_only_update');
  } finally {
    seeded?.close();
    await removeTestDirectory(dir);
  }
});

test('Store reload fails closed before repairing a deleted economic source-link trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-source-links-'));
  const dbPath = join(dir, 'ledger.sqlite');
  let seeded: Store | null = null;
  try {
    seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_event_sources_append_only_update').run();
    seeded.close();
    seeded = null;

    expectReloadFailure(dbPath, 'economic_event_sources_append_only_update');
  } finally {
    seeded?.close();
    await removeTestDirectory(dir);
  }
});

test('Store reload fails closed before operating with a tampered economic source-link trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-source-links-tampered-'));
  const dbPath = join(dir, 'ledger.sqlite');
  let seeded: Store | null = null;
  try {
    seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_event_sources_append_only_delete').run();
    seeded.raw().prepare(
      'CREATE TRIGGER economic_event_sources_append_only_delete BEFORE DELETE ON economic_event_sources BEGIN SELECT 1; END',
    ).run();
    seeded.close();
    seeded = null;

    expectReloadFailure(dbPath, 'economic_event_sources_append_only_delete', /SELECT 1/);
  } finally {
    seeded?.close();
    await removeTestDirectory(dir);
  }
});

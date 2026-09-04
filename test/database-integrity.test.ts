import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';

test('Store reload fails closed when an economic append-only trigger is deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-'));
  const dbPath = join(dir, 'ledger.sqlite');
  try {
    const seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_events_append_only_update').run();
    seeded.close();

    assert.throws(() => new Store(dbPath), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CAUSAL_IO_FAILURE:/);
      return true;
    });

    const retained = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const trigger = retained.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'economic_events_append_only_update'",
      ).get() as { present: number } | undefined;
      assert.equal(trigger, undefined, 'failed reload must not repair the deleted trigger');
    } finally {
      retained.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Store reload fails closed before repairing a deleted economic source-link trigger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-source-links-'));
  const dbPath = join(dir, 'ledger.sqlite');
  try {
    const seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_event_sources_append_only_update').run();
    seeded.close();

    assert.throws(() => new Store(dbPath), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CAUSAL_IO_FAILURE:/);
      return true;
    });

    const retained = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const trigger = retained.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'economic_event_sources_append_only_update'",
      ).get() as { present: number } | undefined;
      assert.equal(trigger, undefined, 'failed reload must not repair the deleted source-link trigger');
    } finally {
      retained.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Store reload fails closed before operating with a tampered economic source-link trigger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-integrity-source-links-tampered-'));
  const dbPath = join(dir, 'ledger.sqlite');
  try {
    const seeded = new Store(dbPath);
    seeded.raw().prepare('DROP TRIGGER economic_event_sources_append_only_delete').run();
    seeded.raw().prepare(
      'CREATE TRIGGER economic_event_sources_append_only_delete BEFORE DELETE ON economic_event_sources BEGIN SELECT 1; END',
    ).run();
    seeded.close();

    assert.throws(() => new Store(dbPath), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CAUSAL_IO_FAILURE:/);
      return true;
    });

    const retained = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const trigger = retained.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'economic_event_sources_append_only_delete'",
      ).get() as { sql: string | null } | undefined;
      assert.match(trigger?.sql ?? '', /SELECT 1/);
    } finally {
      retained.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

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

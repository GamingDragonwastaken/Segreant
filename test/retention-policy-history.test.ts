import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';

test('retention policy changes are append-only evidence separate from deletion rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-retention-policy-'));
  const prior = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  try {
    const store = new Store(join(home, 'segreant.db'));
    try {
      assert.deepEqual(store.retentionPolicyChanges(), []);
      assert.equal(store.recordRetentionPolicyChange('requests', 180, 90, 1_000, 'settings'), 'created');
      assert.equal(store.recordRetentionPolicyChange('requests', 180, 90, 1_000, 'settings'), 'existing');
      assert.equal(store.recordRetentionPolicyChange('requests', 90, 365, 2_000, 'settings'), 'created');
      const changes = store.retentionPolicyChanges('requests');
      assert.equal(changes.length, 2);
      assert.deepEqual(changes.map((change) => [change.previousDays, change.nextDays]), [[180, 90], [90, 365]]);
      assert.equal(store.retentionPolicyChanges('proposals').length, 0);
      assert.equal(store.retentionPolicyChanges()[0]?.stream, 'requests');
      assert.throws(
        () => store.raw().prepare('DELETE FROM retention_policy_changes').run(),
        /append-only|trigger|denied/i,
      );
    } finally {
      store.close();
    }
  } finally {
    if (prior === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
});


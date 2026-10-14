import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { ensureDemoSeeded } from '../src/cli/runCmd.ts';

// `segreant start --demo` on a fresh install served an empty demo.db: every
// page said "sample data" above $0 and "no recorded requests in this period".

test('an empty sample ledger is filled before the dashboard serves it', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.earliestRequestMs(), null);
    const seeded = ensureDemoSeeded(store);
    assert.ok(seeded && seeded.requests > 0, 'the empty sample ledger was not seeded');
    const now = Date.now();
    assert.ok(store.spendBetween(now - 30 * 86_400_000, now + 1) > 0, 'the last 30 days are still empty after seeding');
  } finally { store.close(); }
});

test('a sample ledger that already has rows is left exactly as it is', () => {
  const store = new Store(':memory:');
  try {
    ensureDemoSeeded(store);
    const before = store.earliestRequestMs();
    const total = store.spendBetween(0, Date.now() + 1);
    assert.equal(ensureDemoSeeded(store), null);
    assert.equal(store.earliestRequestMs(), before);
    assert.equal(store.spendBetween(0, Date.now() + 1), total);
  } finally { store.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RequestRow } from '../src/store/db.ts';
import { BudgetGuard } from '../src/budget/guard.ts';
import type { BudgetConfig } from '../src/config.ts';

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: Date.now(), provider: 'anthropic',
    model: 'm', project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1, estimated: false, streamed: false, statusCode: 200,
    durationMs: 1, ...over,
  };
}

function budget(over: Partial<BudgetConfig>): BudgetConfig {
  return { dailyUsd: null, dailySoftUsd: null, sessionUsd: null, runawayWindowSec: 60, runawayMaxUsd: null, capIncludesImported: false, ...over };
}

test('cap basis: imported spend does NOT trip the daily cap by default (the dogfood freeze)', () => {
  const store = new Store(':memory:');
  // $158 of imported subscription spend, $2 of live proxy spend — the real incident shape.
  store.insertRequestIfNew(req({ costUsd: 158, via: 'import' }));
  store.insertRequest(req({ costUsd: 2 })); // via defaults to 'proxy'

  const guard = new BudgetGuard(store, budget({ dailyUsd: 150 }));
  const d = guard.evaluate();
  assert.equal(d.action, 'allow'); // live spend $2 is nowhere near the cap
  assert.equal(d.daySpendUsd, 2);

  // Opt in to total-spend governance → same data now blocks, and says why.
  const strict = new BudgetGuard(store, budget({ dailyUsd: 150, capIncludesImported: true }));
  const s = strict.evaluate();
  assert.equal(s.action, 'block');
  assert.ok(s.reason!.includes('includes imported'));
  store.close();
});

test('cap basis: live proxy spend still blocks exactly as before', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ costUsd: 151 }));
  const d = new BudgetGuard(store, budget({ dailyUsd: 150 })).evaluate();
  assert.equal(d.action, 'block');
  assert.ok(d.reason!.includes('imported spend excluded'));
  store.close();
});

test('cap basis: a runtime config supplier makes an already-running guard honor a newly saved cap', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ costUsd: 5 }));
    let live = budget({ dailyUsd: null });
    const guard = new BudgetGuard(store, () => live);
    assert.equal(guard.evaluate().action, 'allow');
    live = budget({ dailyUsd: 5 });
    assert.equal(guard.evaluate().action, 'block', 'the proxy must not need a restart before a saved cap takes effect');
  } finally {
    store.close();
  }
});

test('via migration: pre-existing rows are backfilled by importer source tag, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-via-'));
  const path = join(dir, 'x.db');
  try {
    // Simulate a pre-`via` database: create via the Store, then drop the column.
    const s1 = new Store(path);
    s1.insertRequest(req({ requestId: 'imp', source: 'claude-code', costUsd: 10 }));
    s1.insertRequest(req({ requestId: 'live', source: null, costUsd: 3 }));
    s1.close();
    const raw = new DatabaseSync(path);
    raw.prepare('ALTER TABLE requests DROP COLUMN via').run();
    raw.close();

    // Re-open: migrate() re-adds the column and backfills from the source tag.
    const s2 = new Store(path);
    const day = 24 * 60 * 60 * 1000;
    assert.equal(s2.spendBetween(Date.now() - day, Date.now() + day, true), 3); // live only
    assert.equal(s2.spendBetween(Date.now() - day, Date.now() + day), 13); // everything
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

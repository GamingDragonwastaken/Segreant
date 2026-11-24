/**
 * A local day is 23 or 25 hours long when the clocks change. A cap that counts
 * 24 hours from midnight stops seeing spend in the last hour of the long one.
 */
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetGuard, endOfLocalDay, startOfLocalDay } from '../src/budget/guard.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Store } from '../src/store/db.ts';

test('a local day ends at the next local midnight, however long it is', () => {
  const hours = (iso: string): number => (endOfLocalDay(Date.parse(iso)) - startOfLocalDay(Date.parse(iso))) / 3_600_000;
  assert.deepEqual([hours('2026-11-01T17:00:00Z'), hours('2026-03-08T17:00:00Z'), hours('2026-06-01T17:00:00Z')], [25, 23, 24]);
});

test('the daily cap counts spend in the last hour of the day the clocks go back', () => {
  const store = new Store(':memory:');
  try {
    const late = Date.parse('2026-11-02T04:30:00Z'); // 23:30 local on 1 November, the 25-hour day
    store.insertRequest({
      requestId: 'late', sessionId: null, tsEpochMs: late, provider: 'anthropic', model: 'claude-opus-4-8', project: 'app', taskWeight: 1,
      inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 30, estimated: false,
      streamed: false, statusCode: 200, durationMs: 1,
    });
    const guard = new BudgetGuard(store, { ...DEFAULT_CONFIG.budget, dailyUsd: 25 });
    assert.equal(guard.evaluate({ nowMs: late + 60_000 }).action, 'block');
  } finally {
    store.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../src/demo/seed.ts';
import { Store } from '../src/store/db.ts';
import { computeAlerts } from '../src/alerts/detect.ts';
import { computeUsageRoI } from '../src/value/usage.ts';
import { startOfLocalDay } from '../src/budget/guard.ts';
import { DEFAULT_CONFIG, type AegisConfig } from '../src/config.ts';

// Local noon today, so the "today" window is well-defined regardless of when the
// suite runs (a seed near local midnight would have almost no room for today).
function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

const demoConfig = (): AegisConfig => ({
  ...DEFAULT_CONFIG,
  budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 30, dailySoftUsd: 20, runawayMaxUsd: 5 },
});

test('demo seed: populates every store-backed surface', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  const res = seedDemo(store, { now });

  assert.ok(res.requests > 100, 'a couple weeks of traffic');
  assert.equal(res.blocked, 5, 'five 429s for the throttling story');
  assert.ok(res.sessions >= 10, 'coding + non-coding sessions');
  assert.ok(res.proposals >= 5, 'coding sessions captured proposals');
  assert.ok(res.totalCostUsd > 40, 'meaningful spend');

  // Spend surfaces are non-empty.
  const summary = store.summary(0, now + 1000);
  assert.equal(summary.requests, res.requests);
  assert.ok(store.byModel(0, now + 1000).length >= 3, 'multi-model');
  assert.ok(store.byUser(0, now + 1000).some((u) => u.label === 'alice@team'), 'per-user attribution');
  store.close();
});

test('demo seed: costs are priced by the real engine, never invented or NaN', () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });
  for (const r of store.recent(500)) {
    assert.ok(Number.isFinite(r.costUsd) && r.costUsd >= 0, `priced row: ${r.costUsd}`);
    // Blocked rows are zero-cost; everything else with tokens must cost something.
    if (r.statusCode !== 429 && r.outputTokens > 0) assert.ok(r.costUsd > 0, 'metered row has a cost');
  }
  store.close();
});

test('demo seed: deterministic — same seed yields identical spend', () => {
  const now = noonToday();
  const a = new Store(':memory:');
  const b = new Store(':memory:');
  const ra = seedDemo(a, { now });
  const rb = seedDemo(b, { now });
  assert.equal(ra.requests, rb.requests);
  assert.equal(ra.totalCostUsd, rb.totalCostUsd, 'cost depends only on the fixed PRNG, not wall-clock');
  a.close();
  b.close();
});

test('demo seed: today breaches the cap and the governance alerts fire', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  const todaySpend = store.spendBetween(startOfLocalDay(now), now + 1000);
  assert.ok(todaySpend > 30, `today's runaway should exceed the $30 demo cap (got ${todaySpend.toFixed(2)})`);

  const ids = computeAlerts(store, demoConfig(), { now }).map((a) => a.id);
  assert.ok(ids.includes('budget-exhausted'), 'hard cap reached');
  assert.ok(ids.includes('spend-spike'), 'today well above the active-day baseline');
  assert.ok(ids.includes('throttled'), '429s surfaced');
});

test('demo seed: spend-spike baseline is per-DAY, not per-request (series bucketing)', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });
  // ~3-4 weeks of data (background chatter + the older commits' AI sessions) →
  // a few dozen DAILY buckets at most, not hundreds (the per-request bucketing
  // bug would yield one bucket per request — the CAST-to-INTEGER fix).
  const buckets = store.series(now - 30 * 86400000, now + 1000, 86400000);
  assert.ok(buckets.length <= 31, `daily buckets over a month, got ${buckets.length}`);
  store.close();
});

test('demo seed: non-coding RoI lights up honestly (partial coverage, not a fake 100%)', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  const usage = computeUsageRoI(store, { startMs: now - 30 * 86400000, endMs: now + 1000 });
  assert.equal(usage.units.length, 6, 'six non-coding sessions');
  assert.equal(usage.realizedUnits, 3, 'three reported positive outcomes realize');
  assert.notEqual(usage.roi.roiIndex, null, 'RoI index is computed, not null');
  assert.ok(Number.isFinite(usage.roi.roiIndex!), 'RoI index is a real number, never NaN');
  assert.equal(usage.roi.coverage, 0.5, 'realization + impact instrumented; acceptance + lift honestly n/a');
  store.close();
});

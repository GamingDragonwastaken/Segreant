import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../src/demo/seed.ts';
import { Store } from '../src/store/db.ts';
import { computeAlerts } from '../src/alerts/detect.ts';
import { computeUsageRoI } from '../src/value/usage.ts';
import { computeCohort } from '../src/value/cohort.ts';
import { realizationFromStore } from '../src/value/realization.ts';
import { computeFrontier } from '../src/value/frontier.ts';
import { startOfLocalDay } from '../src/budget/guard.ts';
import { isDeclaredAttribution } from '../src/value/characterization.ts';
import { DEFAULT_CONFIG, type FiscusConfig } from '../src/config.ts';

// Local noon today, so the "today" window is well-defined regardless of when the
// suite runs (a seed near local midnight would have almost no room for today).
function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

const demoConfig = (): FiscusConfig => ({
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

test('demo seed: provides a clearly review-only cheaper-model trial, not a routing decision', () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });
  const trial = computeFrontier(realizationFromStore(store).units).modelSwitches.find((item) => item.taskType === 'feature');
  assert.ok(trial, 'the synthetic demo has two like-for-like mature feature cohorts');
  assert.equal(trial!.incumbentModel, 'claude-opus-4-8');
  assert.equal(trial!.candidateModel, 'claude-haiku-4-5');
  assert.equal(trial!.incumbentUnits, 3);
  assert.equal(trial!.candidateUnits, 3);
  assert.ok(trial!.historicalEquivalentHeadroomUsd > 0, 'candidate is genuinely cheaper in the synthetic cohort');
  assert.equal(trial!.confidence, 'trial', 'six tiny synthetic units must not render as evidence-supported');

  // The cohort must be a LIKE-FOR-LIKE comparison, not a cheap model handed
  // smaller work. Cost-per-unit is blind to unit size, so if the seed drifts to
  // wildly different sizes the demo would showcase a confounded result — which is
  // exactly what it did before this was pinned (85 vs 330 median lines, 3.9x).
  assert.deepEqual(trial!.confounders, [], 'the showcase cohort must not be confounded');
  const sizeRatio =
    Math.max(trial!.candidateMedianUnitLines, trial!.incumbentMedianUnitLines) /
    Math.min(trial!.candidateMedianUnitLines, trial!.incumbentMedianUnitLines);
  assert.ok(sizeRatio < 1.5, `demo cohort unit sizes must stay comparable (got ${sizeRatio.toFixed(2)}x)`);
  // Assumptions are always disclosed even on a clean cohort — they are limits of
  // the method, not defects of this data.
  assert.ok(trial!.assumptions.length >= 4, 'the method still ships what it cannot verify');
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
  assert.equal(usage.units.length, 18, 'eighteen non-coding sessions (three per dev across six devs)');
  assert.equal(usage.realizedUnits, 9, 'nine reported positive outcomes realize');
  assert.notEqual(usage.roi.roiIndex, null, 'RoI index is computed, not null');
  assert.ok(Number.isFinite(usage.roi.roiIndex!), 'RoI index is a real number, never NaN');
  assert.equal(usage.roi.coverage, 0.5, 'realization + impact instrumented; acceptance + lift honestly n/a');
  // Graded reach is seeded (not all flattened to one bucket).
  assert.ok(usage.outcomeMix.published > 0 && usage.outcomeMix.resolved > 0 && usage.outcomeMix.used > 0, 'a spread of reach');
  store.close();
});

test('demo seed: exercises every attribution route the product can actually produce', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  const seen = new Set(store.recent(2000).map((r) => r.attributionBasis));
  // The demo used to label every row `synthetic_demo`, which left both the
  // coverage CLI and the dashboard's By-project basis line structurally blank —
  // the two attribution mechanisms could only be seen with a real repository and
  // a real transcript corpus. The seed now DEPICTS the acquisition routes.
  for (const basis of [
    'client_declared',
    'unattributed',
    'tool_log_repo_resolved',
    'tool_log_inferred',
    'tool_log_fallback',
  ] as const) {
    assert.ok(seen.has(basis), `the demo must show what ${basis} looks like`);
  }
  assert.ok(!seen.has('synthetic_demo'), 'a depicted route, not a self-negating label');
  assert.ok(!seen.has('legacy_unknown'), 'nothing seeded should read as pre-lineage data');
  store.close();
});

test('demo seed: no seeded row depicts a combination the product could not produce', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  for (const r of store.recent(2000)) {
    switch (r.attributionBasis) {
      case 'client_declared':
        assert.equal(r.via, 'proxy', 'a header can only be declared on the proxy path');
        assert.notEqual(r.project, 'default', 'a declared label is never the no-project placeholder');
        break;
      case 'unattributed':
        // The proxy meters the spend but cannot place it, so it stores the row
        // under `default` — which is a placeholder, not a project.
        assert.equal(r.via, 'proxy');
        assert.equal(r.project, 'default');
        break;
      case 'tool_log_repo_resolved':
        assert.equal(r.via, 'import', 'repo resolution only happens on an import');
        assert.ok(r.cwd, 'the resolution has to have had a directory to resolve');
        break;
      case 'tool_log_inferred':
        assert.equal(r.via, 'import');
        assert.ok(r.cwd, 'inferred from a path means a path was recorded');
        break;
      case 'tool_log_fallback':
        assert.equal(r.via, 'import');
        assert.equal(r.cwd, null, 'the placeholder exists precisely because no path was recorded');
        break;
      default:
        assert.fail(`unexpected seeded basis: ${r.attributionBasis}`);
    }
  }
  store.close();
});

test('demo seed: the unallocated bucket holds real money, not a rounding error', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  const rows = store.attributionEvidenceByProject(0, now + 1000);
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const unattributed = rows
    .filter((r) => r.attributionBasis === 'unattributed')
    .reduce((s, r) => s + r.costUsd, 0);
  // A coverage gap only prompts anyone to close it if it costs something. But it
  // must also stay a tail — the demo's job is still to tell a per-project spend
  // story, and an unallocated majority would drown it.
  const share = unattributed / total;
  assert.ok(share > 0.03 && share < 0.25, `unallocated share should be visible but not dominant (got ${(share * 100).toFixed(1)}%)`);

  // …and the demo must not flatter itself into a perfect score either.
  const declared = rows.filter((r) => isDeclaredAttribution(r.attributionBasis)).reduce((s, r) => s + r.costUsd, 0);
  assert.ok(declared / total < 1, 'a 100% coverage demo would teach the wrong lesson');
  store.close();
});

test('demo seed: imported rows do not leak into what a cap can enforce', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  // Import-metered spend is observed after the fact and cannot be blocked, so
  // the budget path reads live proxy traffic only. Today's runaway is proxied on
  // purpose: routing it through an importer would quietly disarm the demo's cap.
  const dayStart = startOfLocalDay(now);
  const all = store.spendBetween(dayStart, now + 1000);
  const live = store.spendBetween(dayStart, now + 1000, true);
  assert.equal(live, all, "today's spend is entirely enforceable");
  assert.ok(live > 30, 'and it still breaches the $30 demo cap on its own');

  // Over the whole period the two genuinely differ — otherwise the demo would
  // never show the distinction it makes a point of drawing.
  assert.ok(store.spendBetween(0, now + 1000, true) < store.spendBetween(0, now + 1000), 'the fortnight contains imported spend');
  store.close();
});

test('demo seed: per-user value clears k-anonymity and shows a real distribution', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  seedDemo(store, { now });

  const rep = computeCohort(store, { startMs: now - 30 * 86400000, endMs: now + 1000, enabled: true, minCohort: 5 });
  assert.equal(rep.suppressed, false, 'six seeded devs clear the k-anonymity floor');
  assert.equal(rep.distribution!.cohortSize, 6);
  assert.ok(rep.distribution!.coachingHeadroomUsd > 0, 'a spread of extraction yields enablement upside');

  // The guardrail still bites when disabled.
  const off = computeCohort(store, { startMs: now - 30 * 86400000, endMs: now + 1000, enabled: false, minCohort: 5 });
  assert.equal(off.suppressed, true);
  assert.equal(off.distribution, null);
  store.close();
});

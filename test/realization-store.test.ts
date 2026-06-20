/**
 * Store-backed realization (slice 2) — realized value persisted so it outlives
 * the process and the checkout that computed it. The load-bearing property is
 * that the cached path and the live path share ONE rollup, so a manager's
 * dashboard (no repo) reads the same numbers a developer's `realize` would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { seedDemo, demoLiftOptions } from '../src/demo/seed.ts';
import { realizationFromStore, rollupRealization, loadRealization, projectValueBreakdown } from '../src/value/realization.ts';
import { computeReturnOnIntelligence } from '../src/value/lenses.ts';
import { computeFrontier } from '../src/value/frontier.ts';

function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

test('store round-trip: rehydrated snapshots feed the SAME rollup (no parallel math)', () => {
  const now = noonToday();
  const a = new Store(':memory:');
  seedDemo(a, { now });

  const repA = realizationFromStore(a, { windowDays: 14 });
  // realizationFromStore must just delegate to rollupRealization on its units —
  // re-rolling the very units it returned has to reproduce its headline exactly.
  const direct = rollupRealization(repA.units, {
    generatedAt: Date.parse(repA.generatedAt),
    windowDays: 14,
    acceptanceThreshold: 0.6,
    survivalThreshold: 0.5,
  });
  assert.deepEqual(repA.matured, direct.matured);
  assert.equal(repA.firstPassAcceptance, direct.firstPassAcceptance);

  // serialize → store → deserialize is itself lossless: persisting the rehydrated
  // units into a fresh store and reading them back yields identical numbers.
  const b = new Store(':memory:');
  b.saveRealizationUnits(
    repA.units.map((u) => ({
      commitHash: u.hash,
      project: 'p',
      tsEpochMs: u.tsEpochMs,
      computedAtMs: now,
      attributedCostUsd: u.attributedCostUsd,
      maturing: u.maturing,
      realized: u.funnel.realized,
      unitJson: JSON.stringify(u),
    })),
  );
  const repB = realizationFromStore(b, { windowDays: 14 });
  assert.deepEqual(repB.matured, repA.matured);
  a.close();
  b.close();
});

test('demo seed: git-correlated value surfaces light up via the real pipeline', () => {
  const store = new Store(':memory:');
  const now = noonToday();
  const res = seedDemo(store, { now });
  assert.equal(res.realizationUnits, 16);
  assert.equal(store.countRealizationUnits(), 16);
  assert.equal(store.countRealizationUnits('backend-api'), 6, 'project filter works');

  const rep = realizationFromStore(store, { windowDays: 14 });
  assert.equal(rep.matured.units, 12, 'units older than the 14d window');
  assert.equal(rep.matured.realizedUnits, 7);
  assert.ok(Math.abs(rep.matured.realizationRate - 7 / 12) < 1e-9);

  // The waste P&L spans several real funnel outcomes, not just "realized".
  const stages = new Set(rep.matured.wasteByStage.map((b) => b.stage));
  assert.ok(stages.has('realized') && stages.size >= 4, `varied outcomes: ${[...stages].join(',')}`);

  const roi = computeReturnOnIntelligence(rep, {});
  assert.ok(roi.roiIndex !== null && roi.roiIndex > 0, 'a real composite');
  assert.equal(roi.indexIsUpperBound, true, 'lift uninstrumented → honest upper bound');

  // The frontier tells the routing story: opus earns its premium on features;
  // gpt-4o keeps failing on refactors.
  const fr = computeFrontier(rep.units);
  const opusFeat = fr.byModelAndTask.find((c) => c.model === 'claude-opus-4-8' && c.taskType === 'feature');
  const gptRefactor = fr.byModelAndTask.find((c) => c.model === 'gpt-4o' && c.taskType === 'refactor');
  assert.ok(opusFeat && opusFeat.roiIndex !== null && opusFeat.roiIndex > 80, 'opus·feature leads RoI');
  assert.ok(gptRefactor && gptRefactor.roiIndex === 0, 'gpt-4o·refactor realizes nothing');
  store.close();
});

test('loadRealization: demo mode serves stored snapshots, never the cwd repo', async () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });

  const prev = process.env.AEGIS_DEMO;
  process.env.AEGIS_DEMO = '1';
  try {
    // process.cwd() may itself be a git repo; demo mode must still read the store.
    const loaded = await loadRealization(store, process.cwd(), { windowDays: 14 });
    assert.ok(loaded, 'snapshots exist → resolves');
    assert.equal(loaded!.source, 'store');
    assert.equal(loaded!.report.matured.units, 12);
  } finally {
    if (prev === undefined) delete process.env.AEGIS_DEMO;
    else process.env.AEGIS_DEMO = prev;
  }
  store.close();
});

test('loadRealization: no repo and no snapshots → null (honest empty, not a fake zero)', async () => {
  const store = new Store(':memory:');
  const loaded = await loadRealization(store, undefined, {});
  assert.equal(loaded, null);
  store.close();
});

test('demo lift: a synthetic TSF lights the 4th lens and a real RoI interval', () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });
  const rep = realizationFromStore(store, { windowDays: 14 });

  // Without a TSF the coding RoI is an upper bound (3/4 lenses). The demo TSF —
  // priced through the real boundedLift — instruments Lift and turns the Index
  // into a partially-identified interval.
  const roi = computeReturnOnIntelligence(rep, demoLiftOptions());
  assert.notEqual(roi.lenses.lift.value, null, 'lift instrumented from the demo TSF');
  assert.equal(roi.indexIsUpperBound, false, 'all four lenses wired → no longer an upper bound');

  const { low, point, high } = roi.roiInterval;
  assert.ok(low !== null && point !== null && high !== null);
  assert.ok(low <= point && point <= high, `contains point: ${low} ≤ ${point} ≤ ${high}`);
  assert.ok(high - low > 0.5, 'a real interval, not a degenerate point');
  store.close();
});

test('value math: net-of-rework realized value ≤ gross, discounted by acceptance', () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });
  const rep = realizationFromStore(store, { windowDays: 14 });
  const m = rep.matured;

  assert.ok(m.netRealizedValueUsd > 0);
  assert.ok(m.netRealizedValueUsd <= m.realizedValueUsd, 'net never exceeds gross');
  assert.ok(m.netRealizedValueUsd < m.realizedValueUsd, 'realized units were < 100% accepted → a real discount');

  // Net = Σ over realized matured units of cost × acceptance (the production formula).
  const expected = rep.units
    .filter((u) => !u.maturing && u.funnel.realized)
    .reduce((s, u) => s + u.attributedCostUsd * (u.acceptance ?? 1), 0);
  assert.ok(Math.abs(m.netRealizedValueUsd - expected) < 1e-9, `${m.netRealizedValueUsd} ≈ ${expected}`);
  store.close();
});

test('team view: per-project value + RoI ranks projects for the budget owner', () => {
  const store = new Store(':memory:');
  seedDemo(store, { now: noonToday() });
  const projects = projectValueBreakdown(store, {});

  assert.ok(projects.length >= 2, 'multiple projects');
  for (const p of projects) {
    assert.ok(p.costUsd > 0, `${p.project} has spend`);
    assert.ok(p.roiIndex !== null, `${p.project} has an RoI`);
    assert.ok(p.netRealizedValueUsd <= p.realizedValueUsd, 'net ≤ gross per project');
  }
  // backend-api (opus features, all realized) must out-RoI data-pipeline (gpt-4o
  // refactors that churned/reverted) — the manager's "fund this, not that" signal.
  const backend = projects.find((p) => p.project === 'backend-api')!;
  const pipeline = projects.find((p) => p.project === 'data-pipeline')!;
  assert.ok(backend.roiIndex! > pipeline.roiIndex!, `backend ${backend.roiIndex} > pipeline ${pipeline.roiIndex}`);
  store.close();
});

/**
 * Pure unit tests for src/aggregate.ts's privacy-gating logic — no HTTP, no
 * store, hand-constructed totals in and expected shapes out. This is where
 * the k-anonymity/opt-in discipline itself gets proven, isolated from
 * whether the SQL/HTTP layers around it work; server.test.ts separately
 * proves the weighted math in store.ts against realistic multi-developer
 * scenarios end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectReport, buildDeveloperReport, buildStandardizedComparison, type TeamAggregateConfig } from '../src/aggregate.ts';
import type { ProjectTotals, DeveloperTotals } from '../src/store.ts';

function project(overrides: Partial<ProjectTotals> = {}): ProjectTotals {
  return {
    project: 'fiscus',
    developerCount: 5,
    rollupCount: 5,
    totalUnits: 100,
    totalCostUsd: 500,
    totalRealizedValueUsd: 400,
    totalNetRealizedValueUsd: 380,
    realizationRate: 0.8,
    realizedValueRate: 0.8,
    avgRoiIndex: 2.5,
    ...overrides,
  };
}

function developer(overrides: Partial<DeveloperTotals> = {}): DeveloperTotals {
  return {
    keyId: 'dev-key',
    label: null,
    rollupCount: 3,
    totalCostUsd: 100,
    totalRealizedValueUsd: 80,
    realizedValueRate: 0.8,
    lastPushedAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

test('buildProjectReport: a project at exactly the k-anonymity floor is shown, not suppressed', () => {
  const [row] = buildProjectReport([project({ developerCount: 5 })], 5);
  assert.equal(row!.suppressed, false);
  if (!row!.suppressed) {
    assert.equal(row!.totalCostUsd, 500);
    assert.equal(row!.avgRoiIndex, 2.5);
  }
});

test('buildProjectReport: one developer short of the floor is suppressed, and leaks no numbers', () => {
  const [row] = buildProjectReport([project({ developerCount: 4, totalCostUsd: 999_999 })], 5);
  assert.equal(row!.suppressed, true);
  const keys = Object.keys(row!);
  // The discriminated union's suppressed branch must not carry any financial field —
  // this is the actual privacy boundary, not just a status flag.
  for (const leaky of ['totalCostUsd', 'totalRealizedValueUsd', 'realizationRate', 'avgRoiIndex']) {
    assert.equal(keys.includes(leaky), false, `suppressed row must not carry ${leaky}`);
  }
  assert.match((row as { reason: string }).reason, /fewer than 5 distinct developers/);
});

test('buildProjectReport: a lone contributor (developerCount 1) is always suppressed under any realistic floor', () => {
  const [row] = buildProjectReport([project({ developerCount: 1 })], 2);
  assert.equal(row!.suppressed, true);
});

test('buildProjectReport: independently suppresses per project — one small project does not hide a large one', () => {
  const rows = buildProjectReport(
    [project({ project: 'niche-tool', developerCount: 1, totalCostUsd: 50 }), project({ project: 'main-app', developerCount: 8, totalCostUsd: 5000 })],
    5,
  );
  const niche = rows.find((r) => r.project === 'niche-tool')!;
  const main = rows.find((r) => r.project === 'main-app')!;
  assert.equal(niche.suppressed, true);
  assert.equal(main.suppressed, false);
});

test('buildDeveloperReport: disabled by default (opt-in) regardless of cohort size', () => {
  const totals = Array.from({ length: 20 }, (_, i) => developer({ keyId: `dev-${i}` }));
  const report = buildDeveloperReport(totals, { minCohort: 5, exposeDeveloperBreakdown: false });
  assert.equal(report.enabled, false);
  assert.equal(report.suppressed, true);
  assert.equal(report.distribution, null);
  assert.match(report.reason, /opt-in/);
});

test('buildDeveloperReport: enabled but below the k-anonymity floor is still suppressed', () => {
  const totals = [developer({ keyId: 'a' }), developer({ keyId: 'b' })];
  const config: TeamAggregateConfig = { minCohort: 5, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  assert.equal(report.enabled, true);
  assert.equal(report.suppressed, true);
  assert.equal(report.distribution, null);
  assert.match(report.reason, /below the k-anonymity floor/);
});

test('buildDeveloperReport: exactly at the floor is shown as a distribution, never a named list', () => {
  const totals = [
    developer({ keyId: 'a', totalCostUsd: 100, totalRealizedValueUsd: 90, realizedValueRate: 0.9 }),
    developer({ keyId: 'b', totalCostUsd: 200, totalRealizedValueUsd: 100, realizedValueRate: 0.5 }),
    developer({ keyId: 'c', totalCostUsd: 300, totalRealizedValueUsd: 300, realizedValueRate: 1.0 }),
    developer({ keyId: 'd', totalCostUsd: 400, totalRealizedValueUsd: 40, realizedValueRate: 0.1 }),
    developer({ keyId: 'e', totalCostUsd: 500, totalRealizedValueUsd: 250, realizedValueRate: 0.5 }),
  ];
  const config: TeamAggregateConfig = { minCohort: 5, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  assert.equal(report.suppressed, false);
  assert.ok(report.distribution);
  const d = report.distribution!;
  assert.equal(d.cohortSize, 5);
  // Median of [100,200,300,400,500] = 300; verifies quantile() isn't silently wired to the wrong array.
  assert.equal(d.medianCostUsd, 300);
  assert.equal(d.totalCostUsd, 1500);
  assert.equal(d.totalRealizedValueUsd, 780);
  // No individual keyId/label anywhere in the response shape — this IS the privacy contract.
  assert.equal(JSON.stringify(report).includes('"a"'), false);
  assert.equal(JSON.stringify(report).includes('keyId'), false);
});

test('buildDeveloperReport: a developer with $0 cost is counted in cohortSize but excluded from the rate distribution, not folded in as 0', () => {
  const totals = [
    developer({ keyId: 'a', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'b', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'c', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'd', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
  ];
  const config: TeamAggregateConfig = { minCohort: 3, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  assert.equal(report.suppressed, false);
  const d = report.distribution!;
  assert.equal(d.cohortSize, 4); // the $0 developer still counts toward cohort size
  // If the $0 developer's rate had been folded in as 0, the median would be
  // pulled down; excluding it entirely, the median of [1,1,1] is exactly 1.
  assert.equal(d.medianRealizedValueRate, 1);
});

test('buildDeveloperReport: the rate distribution is suppressed on its own when excluding $0-cost developers drops it below the k-anonymity floor, even though the raw cohort clears it', () => {
  const totals = [
    developer({ keyId: 'a', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'b', totalCostUsd: 0, totalRealizedValueUsd: 0, realizedValueRate: null }),
    developer({ keyId: 'c', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'd', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
    developer({ keyId: 'e', totalCostUsd: 100, totalRealizedValueUsd: 100, realizedValueRate: 1.0 }),
  ];
  const config: TeamAggregateConfig = { minCohort: 5, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport(totals, config);
  // totals.length (5) clears minCohort (5), but rates.length (3, after
  // excluding the two $0-cost developers) does not — the disclosed rate axis
  // must not be shown over a sub-cohort smaller than the configured floor.
  assert.equal(report.suppressed, true);
  assert.equal(report.distribution, null);
  assert.match(report.reason, /rate cohort of 3/);
});

test('buildDeveloperReport: report never resolves developerCount = 0 into a false "shown" state', () => {
  const config: TeamAggregateConfig = { minCohort: 5, exposeDeveloperBreakdown: true };
  const report = buildDeveloperReport([], config);
  assert.equal(report.suppressed, true);
  assert.equal(report.distribution, null);
});

test('Simpson defense: identical within-stratum performance, reversed raw ranking — standardization removes the reversal', () => {
  // Both teams: 90% realization on `fix` tasks, 30% on `feature` tasks.
  // Team A worked mostly fixes (easy mix), Team B mostly features (hard mix).
  const teamA = {
    label: 'team-a',
    strata: [
      { stratum: 'fix', value: 0.9, activity: 90 },
      { stratum: 'feature', value: 0.3, activity: 10 },
    ],
  };
  const teamB = {
    label: 'team-b',
    strata: [
      { stratum: 'fix', value: 0.9, activity: 10 },
      { stratum: 'feature', value: 0.3, activity: 90 },
    ],
  };
  const cmp = buildStandardizedComparison([teamA, teamB]);
  const a = cmp.rows.find((r) => r.label === 'team-a')!;
  const b = cmp.rows.find((r) => r.label === 'team-b')!;

  // The naive pooled numbers "rank" A far above B on task mix alone: 0.84 vs 0.36.
  assert.ok(a.raw! > b.raw! + 0.4, `raw pooled scores must show the mix artifact (${a.raw} vs ${b.raw})`);
  // At a fixed basket the two teams are indistinguishable — performance is identical.
  assert.ok(
    Math.abs(a.standardized.score! - b.standardized.score!) < 1e-9,
    `standardized scores must agree when within-stratum performance is identical (${a.standardized.score} vs ${b.standardized.score})`,
  );
});

test('buildStandardizedComparison: operator-pinned weights win over the pooled-mix fallback, and the provenance says which was used', () => {
  const entities = [
    { label: 'x', strata: [{ stratum: 'fix', value: 0.9, activity: 100 }] },
    { label: 'y', strata: [{ stratum: 'fix', value: 0.7, activity: 1 }] },
  ];
  const pinned = buildStandardizedComparison(entities, { fix: 1, feature: 1 });
  assert.match(pinned.basketSource, /operator-pinned/);
  assert.deepEqual(pinned.referenceBasket, { fix: 1, feature: 1 });
  const fallback = buildStandardizedComparison(entities);
  assert.match(fallback.basketSource, /pooled activity mix/);
});

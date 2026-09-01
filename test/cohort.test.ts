import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cohortReport,
  computeCohortDistribution,
  selfView,
  type UserValueRow,
} from '../src/value/cohort.ts';

function row(user: string, sessions: number, realizedSessions: number, costUsd: number): UserValueRow {
  return { user, sessions, realizedSessions, costUsd, realizedValueUsd: (realizedSessions / sessions) * costUsd };
}

// A cohort of 6 identical-cost users with a spread of realized shares.
function cohort6(): UserValueRow[] {
  return [
    row('a', 10, 9, 10), // 0.9
    row('b', 10, 8, 10), // 0.8
    row('c', 10, 6, 10), // 0.6
    row('d', 10, 5, 10), // 0.5
    row('e', 10, 3, 10), // 0.3
    row('f', 10, 2, 10), // 0.2
  ];
}

test('cohort: per-user value is OFF by default (opt-in) — nothing emitted', () => {
  const rep = cohortReport(cohort6(), { enabled: false });
  assert.equal(rep.enabled, false);
  assert.equal(rep.suppressed, true);
  assert.equal(rep.distribution, null);
  assert.match(rep.reason, /opt-in/);
});

test('cohort: k-anonymity — a small team cannot get per-user value even when enabled', () => {
  const small = cohort6().slice(0, 4); // 4 users < default k of 5
  const rep = cohortReport(small, { enabled: true });
  assert.equal(rep.suppressed, true);
  assert.equal(rep.distribution, null);
  assert.match(rep.reason, /k-anonymity|floor/);

  // Exactly at the floor, it opens up.
  const ok = cohortReport(cohort6().slice(0, 5), { enabled: true, minCohort: 5 });
  assert.equal(ok.suppressed, false);
  assert.ok(ok.distribution);
});

test("cohort: 'unassigned' traffic is never a person — excluded from the cohort", () => {
  const rows = [...cohort6(), row('unassigned', 50, 40, 100)];
  const rep = cohortReport(rows, { enabled: true });
  assert.equal(rep.distribution!.cohortSize, 6, 'unassigned excluded');
});

test('cohort: report is distribution-only — it never exposes a per-user list', () => {
  const rep = cohortReport(cohort6(), { enabled: true });
  // The distribution object has no field that could carry names/rows.
  const keys = Object.keys(rep.distribution!);
  assert.ok(!keys.some((k) => /user|name|rows|list|members|rank/i.test(k)), `no per-user field, got ${keys.join(',')}`);
});

test('cohort: coaching headroom is the sub-median enablement upside, and zero when everyone is at/above median', () => {
  const d = computeCohortDistribution(cohort6());
  assert.ok(d.coachingHeadroomUsd > 0, 'a spread cohort has enablement upside');
  // Headroom must not exceed lifting EVERYONE to the median (a sane upper frame).
  assert.ok(d.coachingHeadroomUsd < d.totalCostUsd, 'headroom is bounded by total spend');

  // A perfectly uniform cohort: nobody is below median → no headroom, broad-based.
  const flat = [row('a', 10, 6, 10), row('b', 10, 6, 10), row('c', 10, 6, 10), row('d', 10, 6, 10), row('e', 10, 6, 10)];
  const df = computeCohortDistribution(flat);
  assert.ok(Math.abs(df.coachingHeadroomUsd) < 1e-9, 'uniform cohort has ~0 headroom');
  assert.equal(df.broadBased, true, 'uniform cohort is broad-based');
  assert.ok(Math.abs(df.dispersion) < 1e-9);
});

test('cohort: thin samples are shrunk toward the mean (nobody judged on 2 sessions)', () => {
  // Same raw 100% share, but one user has 2 sessions and one has 40. The thin
  // user must be pulled harder toward the cohort mean.
  const rows = [
    row('bigwin', 40, 40, 40), // raw 1.0, lots of evidence
    row('thinwin', 2, 2, 2), // raw 1.0, almost no evidence
    row('mid', 20, 12, 20),
    row('low1', 20, 8, 20),
    row('low2', 20, 6, 20),
  ];
  const self = (u: string) => selfView(rows, u, { enabled: true, minCohort: 5 })!;
  const big = self('bigwin');
  const thin = self('thinwin');
  assert.ok(thin.extraction < big.extraction, 'the thin 100% is shrunk below the well-evidenced 100%');
  assert.ok(thin.localDataWeight < big.localDataWeight, 'a thin sample carries less of its own weight and more of the cohort prior');
});

test('cohort: selfView returns your own number always, but gates the peer comparison', () => {
  const rows = cohort6();
  // Enabled + cohort ok → comparison available.
  const withPeers = selfView(rows, 'a', { enabled: true, minCohort: 5 })!;
  assert.ok(withPeers.cohortComparable);
  assert.ok(withPeers.percentile !== null && withPeers.percentile > 0.5, 'top extractor ranks high');
  assert.ok(withPeers.vsMedianPct !== null && withPeers.vsMedianPct > 0);

  // Disabled → you still see your own extraction, but no peer comparison leaks.
  const solo = selfView(rows, 'a', { enabled: false })!;
  assert.equal(solo.cohortComparable, false);
  assert.equal(solo.percentile, null);
  assert.equal(solo.vsMedianPct, null);
  assert.ok(solo.extraction > 0, 'your own number is your own data');

  // Unknown user → null.
  assert.equal(selfView(rows, 'ghost', { enabled: true }), null);
});

test('cohort: dispersion separates a broad cohort from a concentrated one', () => {
  const broad = computeCohortDistribution([
    row('a', 10, 6, 10), row('b', 10, 6, 10), row('c', 10, 5, 10), row('d', 10, 6, 10), row('e', 10, 5, 10),
  ]);
  const concentrated = computeCohortDistribution([
    row('a', 10, 10, 10), row('b', 10, 1, 10), row('c', 10, 10, 10), row('d', 10, 1, 10), row('e', 10, 1, 10),
  ]);
  assert.ok(broad.dispersion < concentrated.dispersion, 'concentrated value shows higher dispersion');
});

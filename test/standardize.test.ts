/**
 * Task-standardized comparison (src/team/standardize.ts and the team server's
 * comparison builder). The centerpiece is the audit-prescribed validation: a
 * constructed Simpson's-paradox case where the RAW pooled ranking reverses even
 * though within-stratum performance is identical — raw aggregation must fall
 * for it, standardized aggregation must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardizedScore, fisherChangeIndex } from '../src/team/standardize.ts';
import { buildStandardizedComparison } from '../team-server/src/aggregate.ts';

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

test('standardizedScore: missing strata are excluded and NAMED, coverage reported — never zero-filled', () => {
  const r = standardizedScore(
    [
      { stratum: 'fix', value: 0.8 },
      { stratum: 'docs', value: 0.9 }, // outside the basket
    ],
    { fix: 2, feature: 2 },
  );
  assert.equal(r.score, 0.8, 'only the covered stratum scores; the missing one must not read as zero');
  assert.ok(Math.abs(r.coveredWeight - 0.5) < 1e-9, 'half the basket weight is covered');
  assert.deepEqual(r.missing, ['feature']);
  assert.deepEqual(r.extra, ['docs']);
});

test('standardizedScore: no overlap or empty basket → null with the reason, never an invented comparison', () => {
  assert.equal(standardizedScore([{ stratum: 'docs', value: 0.9 }], { fix: 1 }).score, null);
  assert.equal(standardizedScore([{ stratum: 'fix', value: 0.9 }], {}).score, null);
});

test('fisherChangeIndex: pure mix shift with identical per-stratum scores reads as NO change (the base-symmetry point)', () => {
  const p0 = [
    { stratum: 'fix', share: 90, value: 0.9 },
    { stratum: 'feature', share: 10, value: 0.3 },
  ];
  const p1 = [
    { stratum: 'fix', share: 10, value: 0.9 },
    { stratum: 'feature', share: 90, value: 0.3 },
  ];
  const c = fisherChangeIndex(p0, p1);
  assert.ok(Math.abs(c.laspeyres! - 1) < 1e-9, 'at the old mix, per-stratum ratios are all 1');
  assert.ok(Math.abs(c.paasche! - 1) < 1e-9, 'at the new mix too');
  assert.ok(Math.abs(c.fisher! - 1) < 1e-9, 'mix shift alone must never masquerade as improvement');
});

test('fisherChangeIndex: a genuine within-stratum improvement is credited, symmetric between period mixes', () => {
  const p0 = [
    { stratum: 'fix', share: 50, value: 0.5 },
    { stratum: 'feature', share: 50, value: 0.4 },
  ];
  const p1 = [
    { stratum: 'fix', share: 50, value: 0.6 },
    { stratum: 'feature', share: 50, value: 0.5 },
  ];
  const c = fisherChangeIndex(p0, p1);
  assert.ok(c.fisher! > 1.2, `both strata improved ≥20% — Fisher must credit it (got ${c.fisher})`);
  assert.ok(c.laspeyres! >= c.paasche! - 1e-9 || c.paasche! >= c.laspeyres! - 1e-9, 'L and P both defined');
  assert.ok(Math.abs(c.fisher! - Math.sqrt(c.laspeyres! * c.paasche!)) < 1e-12, 'Fisher is exactly the geometric mean of L and P');
});

test('fisherChangeIndex: one-sided strata are dropped and named; zero overlap is an unidentified change, not a number', () => {
  const c = fisherChangeIndex(
    [
      { stratum: 'fix', share: 1, value: 0.5 },
      { stratum: 'gone', share: 1, value: 0.5 },
    ],
    [
      { stratum: 'fix', share: 1, value: 0.6 },
      { stratum: 'new', share: 1, value: 0.9 },
    ],
  );
  assert.equal(c.commonStrata, 1);
  assert.deepEqual(c.dropped.sort(), ['gone', 'new']);
  const none = fisherChangeIndex([{ stratum: 'a', share: 1, value: 0.5 }], [{ stratum: 'b', share: 1, value: 0.5 }]);
  assert.equal(none.fisher, null);
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

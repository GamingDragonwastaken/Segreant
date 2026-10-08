/**
 * The first-run answer: kept / not kept / unknown / maturing from git alone, and
 * the period's spend that no commit covers, split by reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptSummary, periodCoverage, type RealizationReport } from '../src/value/realization.ts';

const DAY = 86_400_000;

function unit(over: { cost: number; survived: 'pass' | 'fail' | 'unknown'; reverted?: boolean; maturing?: boolean; ts?: number }) {
  return {
    attributedCostUsd: over.cost,
    reverted: over.reverted ?? false,
    maturing: over.maturing ?? false,
    tsEpochMs: over.ts ?? 0,
    funnel: { results: [{ gate: 'survived', verdict: over.survived }] },
  } as unknown as RealizationReport['units'][number];
}

test('kept, not kept, unknown and maturing are separate, and a revert is never kept', () => {
  const k = keptSummary({
    windowDays: 14,
    units: [
      unit({ cost: 10, survived: 'pass' }),
      unit({ cost: 4, survived: 'pass', reverted: true }),
      unit({ cost: 3, survived: 'fail' }),
      unit({ cost: 2, survived: 'unknown' }),
      unit({ cost: 1, survived: 'unknown', maturing: true, ts: 5 * DAY }),
      unit({ cost: 1, survived: 'unknown', maturing: true, ts: 3 * DAY }),
    ],
  });
  assert.deepEqual(k.kept, { units: 1, costUsd: 10 });
  assert.deepEqual(k.notKept, { units: 2, costUsd: 7 });
  assert.deepEqual(k.unknown, { units: 1, costUsd: 2 });
  assert.equal(k.maturing.units, 2);
  assert.equal(k.maturing.nextVerdictMs, 3 * DAY + 14 * DAY, 'the earliest verdict date');
});

test('period spend splits into on-a-commit, before the oldest commit, no commit followed, and not committed yet', () => {
  const units = [
    { windowStartMs: 10, windowEndMs: 20 },
    { windowStartMs: 40, windowEndMs: 50 },
  ];
  const rows = [
    { tsEpochMs: 5, costUsd: 1 },   // before the oldest window
    { tsEpochMs: 15, costUsd: 2 },  // on a commit
    { tsEpochMs: 30, costUsd: 4 },  // between windows: no commit followed
    { tsEpochMs: 45, costUsd: 8 },  // on a commit
    { tsEpochMs: 50, costUsd: 16 }, // at the newest window end: not committed yet
  ];
  const c = periodCoverage(rows, units, 0, 100);
  assert.equal(c.scopedCostUsd, 31);
  assert.equal(c.onCommitsUsd, 10);
  assert.equal(c.beforeOldestUsd, 1);
  assert.equal(c.noCommitFollowedUsd, 4);
  assert.equal(c.notCommittedYetUsd, 16);
  assert.equal(c.onCommitsUsd + c.beforeOldestUsd + c.noCommitFollowedUsd + c.notCommittedYetUsd, c.scopedCostUsd,
    'every dollar lands in exactly one bucket');
});

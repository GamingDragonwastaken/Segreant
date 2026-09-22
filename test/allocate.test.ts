/**
 * Value-aware allocation (src/budget/allocate.ts) — the "manage the budget" layer.
 * The engine must conserve the total, tilt toward RoI without zeroing a context,
 * and project the realized-value gain of a reallocation honestly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendAllocation, type AllocationCell } from '../src/budget/allocate.ts';

const cells = (): AllocationCell[] => [
  { key: 'opus·feature', costUsd: 12, roiIndex: 97, spendOnRealizedUnitsUsd: 12 }, // rvr 1.0
  { key: 'gpt-4o·refactor', costUsd: 3, roiIndex: 0, spendOnRealizedUnitsUsd: 0 }, // rvr 0
];

test('allocation: re-weights the same budget toward higher RoI, total conserved', () => {
  const plan = recommendAllocation(cells());
  const total = plan.items.reduce((s, i) => s + i.recommendedUsd, 0);
  assert.ok(Math.abs(total - plan.totalUsd) < 1e-6, `total conserved: ${total} vs ${plan.totalUsd}`);

  const opus = plan.items.find((i) => i.key === 'opus·feature')!;
  const gpt = plan.items.find((i) => i.key === 'gpt-4o·refactor')!;
  assert.ok(opus.deltaUsd > 0, 'high-RoI context grows');
  assert.ok(gpt.deltaUsd < 0, 'zero-RoI context shrinks');
  assert.ok(gpt.recommendedUsd > 0, 'but is not zeroed outright (the RoI floor)');
});

test('allocation: tilt=0 is a no-op; tilt scales the move', () => {
  const none = recommendAllocation(cells(), { tilt: 0 });
  assert.ok(none.items.every((i) => Math.abs(i.deltaUsd) < 1e-9), 'tilt 0 leaves the status quo');
  const half = recommendAllocation(cells(), { tilt: 0.5 });
  const full = recommendAllocation(cells(), { tilt: 1 });
  const hOpus = half.items.find((i) => i.key === 'opus·feature')!.deltaUsd;
  const fOpus = full.items.find((i) => i.key === 'opus·feature')!.deltaUsd;
  assert.ok(hOpus > 0 && hOpus < fOpus, 'half tilt moves less than full');
});

test('allocation: labels raw trim→grow arithmetic as an exploratory, non-causal scenario', () => {
  const plan = recommendAllocation(cells());
  assert.equal(plan.evidenceClass, 'exploratory_raw');
  assert.ok(plan.moves.length >= 1, 'a concrete move is proposed');
  const m = plan.moves[0]!;
  assert.equal(m.fromKey, 'gpt-4o·refactor', 'trims the laggard');
  assert.equal(m.toKey, 'opus·feature', 'feeds the leader');
  // gain = amount × (rvr_to − rvr_from) = amount × (1 − 0)
  assert.ok(Math.abs(m.rawRateScenarioGainUsd - m.amountUsd) < 1e-6, 'raw arithmetic equals the move at these rates');
  assert.equal(plan.rawRateScenarioGainUsd, plan.projectedValueGainUsd, 'legacy field is retained only as the same explicitly raw arithmetic');
  assert.match(plan.assumptions[0]!, /EXPLORATORY RAW/i);
});

test('allocation: unscored (no-RoI) contexts are held at status quo', () => {
  const plan = recommendAllocation([
    { key: 'a', costUsd: 10, roiIndex: 80, spendOnRealizedUnitsUsd: 8 },
    { key: 'unknown', costUsd: 5, roiIndex: null, spendOnRealizedUnitsUsd: 0 },
  ]);
  const unk = plan.items.find((i) => i.key === 'unknown')!;
  assert.equal(unk.deltaUsd, 0, 'no RoI → never reallocated');
  const total = plan.items.reduce((s, i) => s + i.recommendedUsd, 0);
  assert.ok(Math.abs(total - 15) < 1e-6, 'total still conserved with an unscored cell');
});

test('allocation: empty / all-unscored input is a safe status-quo plan', () => {
  assert.deepEqual(recommendAllocation([]).moves, []);
  const allNull = recommendAllocation([{ key: 'x', costUsd: 5, roiIndex: null, spendOnRealizedUnitsUsd: 0 }]);
  assert.equal(allNull.moves.length, 0);
  assert.equal(allNull.items[0]!.deltaUsd, 0);
});

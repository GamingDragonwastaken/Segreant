/**
 * Properties of the Return-on-Intelligence equation (docs/RETURN-ON-INTELLIGENCE.md).
 * These are the mathematical claims the derivation rests on — if any fails, the
 * "forced, not chosen" argument breaks, so they are tested as first-class.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnOnIntelligence, weightedPowerMean, type RealizationLike } from '../src/value/lenses.ts';

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function report(over: Partial<RealizationLike> = {}): RealizationLike {
  const unit = (realized: boolean) => ({
    maturing: false,
    acceptance: 0.8,
    funnel: { realized, results: [{ gate: 'shipped' as const, verdict: realized ? ('pass' as const) : ('unknown' as const) }] },
  });
  return {
    firstPassAcceptance: 0.8,
    units: [unit(true), unit(true), unit(false)],
    matured: { realizationRate: 2 / 3, totalCostUsd: 10, realizedValueUsd: 6 },
    ...over,
  };
}

test('aggregator is MULTIPLICATIVE: M(x·y) = M(x)·M(y) — the property that forces the geometric mean', () => {
  const x = [{ value: 0.5, weight: 1 }, { value: 0.8, weight: 2 }, { value: 0.9, weight: 1 }];
  const y = [{ value: 0.6, weight: 1 }, { value: 0.4, weight: 2 }, { value: 0.7, weight: 1 }];
  const xy = x.map((p, i) => ({ value: p.value * y[i]!.value, weight: p.weight }));
  approx(weightedPowerMean(xy, 0), weightedPowerMean(x, 0) * weightedPowerMean(y, 0));

  // The arithmetic mean (θ=1) does NOT have this property — i.e. it's the wrong aggregator.
  assert.ok(Math.abs(weightedPowerMean(xy, 1) - weightedPowerMean(x, 1) * weightedPowerMean(y, 1)) > 1e-3);
});

test('aggregator COLLAPSES on any zero lens (Goodhart-proof) for θ ≤ 0', () => {
  assert.equal(weightedPowerMean([{ value: 0, weight: 1 }, { value: 1, weight: 1 }], 0), 0);
  assert.equal(weightedPowerMean([{ value: 0, weight: 1 }, { value: 1, weight: 1 }], -4), 0);
  // The arithmetic mean would NOT collapse — it rewards gaming one axis.
  assert.ok(weightedPowerMean([{ value: 0, weight: 1 }, { value: 1, weight: 1 }], 1) > 0);
});

test('CES ordering: arithmetic ≥ geometric ≥ near-min (the power-mean inequality)', () => {
  const p = [{ value: 0.2, weight: 1 }, { value: 0.9, weight: 1 }];
  const arith = weightedPowerMean(p, 1);
  const geo = weightedPowerMean(p, 0);
  const nearMin = weightedPowerMean(p, -8);
  assert.ok(arith > geo, `${arith} > ${geo}`);
  assert.ok(geo > nearMin, `${geo} > ${nearMin}`);
  assert.ok(nearMin < 0.35 && nearMin >= 0.2, `θ→−∞ approaches the min (0.2): ${nearMin}`);
});

test('RoI is INTERVAL-valued: the counterfactual range yields an Index interval that contains the point', () => {
  const r = computeReturnOnIntelligence(report(), { lift: 0.5, liftRange: { low: 0.3, high: 0.7 } });
  const { low, point, high } = r.roiInterval;
  assert.ok(low !== null && point !== null && high !== null);
  assert.ok(low! <= point! && point! <= high!, `contains point: ${low} ≤ ${point} ≤ ${high}`);
  assert.ok(high! - low! > 0.5, 'a real interval, not a degenerate point');
});

test('Index is monotone increasing in Lift', () => {
  const lo = computeReturnOnIntelligence(report(), { lift: 0.3 }).roiIndex!;
  const hi = computeReturnOnIntelligence(report(), { lift: 0.7 }).roiIndex!;
  assert.ok(hi > lo, `${hi} > ${lo}`);
});

test('partial instrumentation makes the Index an explicit UPPER bound', () => {
  // Lift un-instrumented (3 of 4 lenses) → upper bound.
  assert.equal(computeReturnOnIntelligence(report(), {}).indexIsUpperBound, true);
  // All four instrumented → not a bound.
  assert.equal(computeReturnOnIntelligence(report(), { lift: 0.6 }).indexIsUpperBound, false);
});

test('a collapsed realization lens zeroes the whole Index — no axis can carry it', () => {
  const dead = report({ matured: { realizationRate: 0, totalCostUsd: 10, realizedValueUsd: 0 } });
  const r = computeReturnOnIntelligence(dead, { lift: 0.6 });
  assert.equal(r.roiIndex, 0);
  assert.ok(r.notes.some((n) => n.includes('collapsed')));
});

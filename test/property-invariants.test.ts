import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendAllocation } from '../src/budget/allocate.ts';
import { anytimeRateInterval } from '../src/value/anytime.ts';
import { computeReturnOnIntelligence, weightedPowerMean, type RealizationLike } from '../src/value/lenses.ts';

function approx(a: number, b: number, eps = 1e-8) {
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
}

let rngState = 0x5f3759df;
function rnd(): number {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}

function report(realizationRate = 0.7, acceptance = 0.8): RealizationLike {
  const realized = Math.round(realizationRate * 10);
  const units = Array.from({ length: 10 }, (_, i) => ({
    maturing: false,
    acceptance,
    funnel: { realized: i < realized, results: [{ gate: 'shipped' as const, verdict: i < realized ? ('pass' as const) : ('fail' as const) }] },
  }));
  return {
    firstPassAcceptance: acceptance,
    units,
    matured: { realizationRate: realized / 10, totalCostUsd: 10, realizedValueUsd: realized },
  };
}

test('property: allocation conserves the same budget across generated portfolios and tilts', () => {
  for (let caseNo = 0; caseNo < 120; caseNo++) {
    const n = 2 + Math.floor(rnd() * 7);
    const cells = Array.from({ length: n }, (_, i) => ({
      key: `c${i}`,
      costUsd: 0.01 + rnd() * 500,
      roiIndex: rnd() < 0.15 ? null : rnd() * 100,
      realizedValueUsd: rnd() * 500,
    }));
    const tilt = rnd();
    const plan = recommendAllocation(cells, { tilt });
    approx(plan.items.reduce((s, x) => s + x.recommendedUsd, 0), plan.totalUsd, 1e-7);
    assert.ok(plan.items.every((x) => x.recommendedUsd >= -1e-9));
  }
});

test('property: anytime-valid rate intervals always contain the observed Bernoulli rate', () => {
  for (let n = 1; n <= 80; n++) {
    const ks = new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n]);
    for (const k of ks) {
      const cs = anytimeRateInterval(k, n);
      const p = k / n;
      assert.ok(cs.low <= p + 1e-12 && p <= cs.high + 1e-12, `${k}/${n}: ${cs.low} ≤ ${p} ≤ ${cs.high}`);
      assert.ok(cs.low >= 0 && cs.high <= 1 && cs.low <= cs.high);
    }
  }
});

test('property: weighted geometric aggregation stays within extrema and is monotone in every lens', () => {
  for (let i = 0; i < 200; i++) {
    const pairs = Array.from({ length: 4 }, () => ({ value: 0.01 + 0.98 * rnd(), weight: 0.1 + 3 * rnd() }));
    const base = weightedPowerMean(pairs, 0);
    const values = pairs.map((p) => p.value);
    assert.ok(base >= Math.min(...values) - 1e-12 && base <= Math.max(...values) + 1e-12);
    const j = i % pairs.length;
    const raised = pairs.map((p, k) => k === j ? { ...p, value: Math.min(1, p.value + 0.05) } : p);
    assert.ok(weightedPowerMean(raised, 0) + 1e-12 >= base, 'raising one lens cannot lower a positive-weight geometric mean');
  }
});

test('property: RoI identification/statistical intervals keep their ordering across generated evidence', () => {
  for (let i = 0; i < 80; i++) {
    const r = computeReturnOnIntelligence(report(0.1 + 0.8 * rnd(), 0.1 + 0.8 * rnd()), {
      lift: 0.2 + 0.6 * rnd(),
      liftRange: { low: 0.1, high: 0.9 },
    });
    const ii = r.instrumentationInterval;
    if (ii.low !== null && ii.observed !== null && ii.high !== null) {
      assert.ok(ii.low <= ii.observed + 1e-12 && ii.observed <= ii.high + 1e-12, `${ii.low} ≤ ${ii.observed} ≤ ${ii.high}`);
    }
    const ri = r.roiInterval;
    if (ri.low !== null && ri.point !== null && ri.high !== null) {
      assert.ok(ri.low <= ri.point + 1e-12 && ri.point <= ri.high + 1e-12);
    }
    const ci = r.compositeInterval;
    if (ci && ci.low !== null && ci.point !== null && ci.high !== null) {
      assert.ok(ci.low <= ci.point + 1e-12 && ci.point <= ci.high + 1e-12);
    }
  }
});

test('property: causal return never exceeds gross return when counterfactual credit is in [0,1]', () => {
  for (let i = 0; i <= 20; i++) {
    const credit = i / 20;
    const r = computeReturnOnIntelligence(report(), {
      lift: credit,
      liftRange: { low: Math.max(0, credit - 0.1), high: Math.min(1, credit + 0.1) },
      grossRealizedValueUsd: 50,
      laborRatePerHour: 60,
      supervisionMinutes: 10,
    });
    const gross = r.returnRatio.grossRatio;
    const causal = r.returnRatio.causalRatio;
    assert.ok(gross !== null && causal !== null);
    assert.ok(causal! <= gross! + 1e-12);
    assert.ok((r.returnRatio.causalRange.low ?? 0) <= (r.returnRatio.causalRange.high ?? Infinity));
  }
});

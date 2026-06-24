/**
 * The money number — Return on Intelligence as a real ratio (value ÷ cost) — and
 * the risk-adjusted certainty-equivalent. These are the claims docs/
 * RETURN-ON-INTELLIGENCE.md §4.5–4.7 rest on, so they are tested as first-class:
 *   · gross = realized manual-equivalent value ÷ (tokens + your measured time)
 *   · causal = gross × counterfactual credit (Lift), applied exactly once
 *   · it refuses to invent a dollar return without measured supervision time
 *   · the certainty-equivalent slides the Index from point → partial-ID lower bound
 *   · Impact is driven by production reach, never by line counts (the M2 fix)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnOnIntelligence, type RealizationLike } from '../src/value/lenses.ts';

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function unit(realized: boolean, shipped = false): RealizationLike['units'][number] {
  return {
    maturing: false,
    acceptance: 0.8,
    funnel: { realized, results: [{ gate: 'shipped', verdict: shipped ? 'pass' : 'unknown' }] },
  };
}

function rep(over: Partial<RealizationLike> = {}): RealizationLike {
  return {
    firstPassAcceptance: 0.8,
    units: [unit(true, true), unit(true), unit(false)],
    matured: { realizationRate: 2 / 3, totalCostUsd: 10, realizedValueUsd: 6, netRealizedValueUsd: 5 },
    ...over,
  };
}

test('RoI return: gross = value ÷ (tokens + measured time); causal = gross × Lift credit; interval from the Lift bound', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60, // $1 / minute
    grossRealizedValueUsd: 250,
    supervisionMinutes: 90,
    lift: 0.5,
    liftRange: { low: 0.3, high: 0.7 },
  });
  const rr = r.returnRatio;
  assert.equal(rr.basis, 'usd');
  approx(rr.costUsd, 100); // $10 token + 90 min × $1/min
  approx(rr.grossRatio!, 2.5); // 250 / 100 — the upper bound on causal return
  approx(rr.causalRatio!, 1.25); // 2.5 × 0.5 — counterfactual credit applied ONCE
  approx(rr.causalRange.low!, 0.75); // 2.5 × 0.3
  approx(rr.causalRange.high!, 1.75); // 2.5 × 0.7
  assert.equal(rr.supervisionPriced, true);
  assert.equal(rr.paysForItself, true); // causal 1.25 ≥ 1
});

test('RoI return: a below-break-even return is flagged (the METR "19% slower" case)', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 120, // little realized value
    supervisionMinutes: 110, // lots of your time
    lift: 0.5,
  });
  const rr = r.returnRatio;
  approx(rr.grossRatio!, 1); // 120 / (10 + 110)
  approx(rr.causalRatio!, 0.5); // × 0.5 → below 1
  assert.equal(rr.paysForItself, false);
});

test('RoI return: refuses to invent a dollar return without measured supervision time', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 250,
    supervisionMinutes: null, // no proxy traffic measured
  });
  assert.equal(r.returnRatio.basis, 'none');
  assert.equal(r.returnRatio.grossRatio, null);
  assert.equal(r.returnRatio.causalRatio, null);
  assert.ok(r.notes.some((n) => /un-priced/i.test(n)), 'explains why it will not fake the number');
});

test('RoI return: gross-only (Lift not wired) is an explicit upper bound on the causal return', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 250,
    supervisionMinutes: 90,
  });
  const rr = r.returnRatio;
  assert.equal(rr.causalRatio, null, 'no counterfactual credit without Lift');
  approx(rr.grossRatio!, 2.5);
  assert.equal(rr.paysForItself, true); // headline falls back to gross 2.5 ≥ 1
});

test('certainty-equivalent: γ slides the Index from the point estimate toward the partial-ID lower bound', () => {
  const o = { lift: 0.5, liftRange: { low: 0.3, high: 0.7 } };
  const point = computeReturnOnIntelligence(rep(), { ...o, riskAversion: 0 });
  const mid = computeReturnOnIntelligence(rep(), { ...o, riskAversion: 0.5 });
  const cons = computeReturnOnIntelligence(rep(), { ...o, riskAversion: 1 });
  assert.equal(point.certaintyEquivalent.index, point.roiIndex); // γ=0 → the point itself
  approx(cons.certaintyEquivalent.index!, point.roiInterval.low!); // γ=1 → the lower bound
  assert.ok(mid.certaintyEquivalent.index! < point.certaintyEquivalent.index!, 'monotone down in γ');
  assert.ok(mid.certaintyEquivalent.index! > cons.certaintyEquivalent.index!);
});

test('Impact is driven by production reach (shipped), not line counts (the M2 fix)', () => {
  // Same realization (one realized unit + one not), differing only in whether the
  // realized unit reached production. No size input exists on the lens at all.
  const matured = { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3, netRealizedValueUsd: 3 };
  const reached = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }));
  const notReached = computeReturnOnIntelligence(rep({ units: [unit(true, false), unit(false)], matured }));
  assert.ok(reached.lenses.impact.value !== null && notReached.lenses.impact.value !== null);
  assert.ok(
    reached.lenses.impact.value! > notReached.lenses.impact.value!,
    `shipped ${reached.lenses.impact.value} should outweigh non-shipped ${notReached.lenses.impact.value}`,
  );
});

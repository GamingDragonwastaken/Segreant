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

test('RoI return: gross = value ÷ (tokens + measured time); Lift does not turn an observational scenario into causal economics', () => {
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
  approx(rr.grossRatio!, 2.5); // 250 / 100 — an observed/manual-equivalent scenario
  assert.equal(rr.causalRatio, null);
  assert.equal(rr.causalRange.low, null);
  assert.equal(rr.causalRange.high, null);
  assert.equal(rr.supervisionPriced, true);
  assert.equal(rr.paysForItself, null);
  assert.equal(rr.evidenceState, 'observational_scenario');
});

test('RoI return: a below-break-even Lift scenario remains non-causal without a qualified study', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 120, // little realized value
    supervisionMinutes: 110, // lots of your time
    lift: 0.5,
  });
  const rr = r.returnRatio;
  approx(rr.grossRatio!, 1); // 120 / (10 + 110)
  assert.equal(rr.causalRatio, null);
  assert.equal(rr.paysForItself, null);
});

test('RoI return: refuses to invent a dollar return without measured supervision time', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 250,
    supervisionMinutes: null, // no proxy traffic measured
  });
  assert.equal(r.returnRatio.basis, 'none');
  assert.equal(r.returnRatio.evidenceState, 'unpriced');
  assert.equal(r.returnRatio.grossRatio, null);
  assert.equal(r.returnRatio.causalRatio, null);
  assert.ok(r.notes.some((n) => /will not invent a dollar return/i.test(n)), 'explains why it will not fake the number');
});

test('RoI return: a gross scenario is explicit about the missing randomized-study evidence', () => {
  const r = computeReturnOnIntelligence(rep(), {
    laborRatePerHour: 60,
    grossRealizedValueUsd: 250,
    supervisionMinutes: 90,
  });
  const rr = r.returnRatio;
  assert.equal(rr.causalRatio, null, 'no counterfactual credit without Lift');
  approx(rr.grossRatio!, 2.5);
  assert.equal(rr.paysForItself, null, 'gross return cannot establish causal break-even');
  assert.ok(
    r.notes.some((n) => /Observed\/manual-equivalent return scenario.*Causal break-even is not established/i.test(n)),
    'the operator sees both the useful scenario and the missing causal evidence',
  );
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

test('Impact is not reconstructed from production gates already counted by Realization', () => {
  const matured = { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3, netRealizedValueUsd: 3 };
  const reached = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }));
  const notReached = computeReturnOnIntelligence(rep({ units: [unit(true, false), unit(false)], matured }));
  assert.equal(reached.lenses.impact.value, null);
  assert.equal(notReached.lenses.impact.value, null);
  const measured = computeReturnOnIntelligence(rep({ units: [unit(true, true), unit(false)], matured }), {
    impact: 0.8,
    impactHow: 'customer exposure sample',
  });
  assert.equal(measured.lenses.impact.value, 0.8);
  assert.equal(measured.lenses.impact.how, 'customer exposure sample');
});

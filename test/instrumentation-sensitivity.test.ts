import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnOnIntelligence } from '../src/value/lenses.ts';
import { instrumentationPriority } from '../src/value/instrumentationSensitivity.ts';
import { scoreFunnel, type Gate, type GateResult, type Verdict } from '../src/value/gates.ts';

function gate(g: Gate, verdict: Verdict): GateResult {
  return { gate: g, verdict, detail: '' };
}

/** Matured units instrument Realization; Impact is supplied separately when known. */
function units(realized: number, failed: number) {
  const pass: Record<Gate, GateResult> = {
    proposed: gate('proposed', 'pass'), accepted: gate('accepted', 'pass'), committed: gate('committed', 'pass'),
    tested: gate('tested', 'pass'), merged: gate('merged', 'pass'), shipped: gate('shipped', 'pass'),
    survived: gate('survived', 'pass'), clean: gate('clean', 'pass'),
  };
  const fail: Record<Gate, GateResult> = { ...pass, survived: gate('survived', 'fail') };
  return [
    ...Array.from({ length: realized }, () => ({ maturing: false, acceptance: null, funnel: scoreFunnel(pass) })),
    ...Array.from({ length: failed }, () => ({ maturing: false, acceptance: null, funnel: scoreFunnel(fail) })),
  ];
}

function roiWithMissingLenses() {
  // Realization + explicit orthogonal Impact instrumented; Acceptance + Lift missing.
  return computeReturnOnIntelligence({
    firstPassAcceptance: null,
    units: units(7, 3),
    matured: { realizationRate: 0.7, totalCostUsd: 10, realizedValueUsd: 7 },
  }, { impact: 0.7, impactHow: 'fixture outcome signal' });
}

test('sensitivity: ranks the heavier missing lens first, with the exposure quantified transparently', () => {
  const roi = roiWithMissingLenses();
  const pri = instrumentationPriority(roi);
  assert.equal(pri.length, 2, 'exactly the un-instrumented lenses');
  assert.equal(pri[0]!.lens, 'lift', 'lift (weight 1.2) is the largest unmeasured exposure');
  assert.equal(pri[1]!.lens, 'acceptance');
  assert.ok(Math.abs(pri[0]!.deltaAtReference) > Math.abs(pri[1]!.deltaAtReference), 'heavier lens moves the Index more');
  // The reference is disclosed and the arithmetic is reproducible by hand:
  // Index_k(v) = 100·exp((Σ wᵢ ln xᵢ + w_k ln v)/(Σ wᵢ + w_k)).
  const p = pri[0]!;
  assert.equal(p.reference, 0.5);
  const wR = 1.0, wI = 1.0, wL = 1.2;
  const expected = 100 * Math.exp((wR * Math.log(roi.lenses.realization.value!) + wI * Math.log(roi.lenses.impact.value!) + wL * Math.log(0.5)) / (wR + wI + wL));
  assert.ok(Math.abs(p.indexAtReference - expected) < 1e-9, 'transparent arithmetic, no hidden priors');
});

test("sensitivity: measuring at a mid reference moves this strong-lens fixture's Index down", () => {
  const roi = roiWithMissingLenses();
  for (const p of instrumentationPriority(roi)) {
    assert.ok(p.deltaAtReference < 0, `${p.lens}: this fixture's disclosed midpoint sensitivity lowers a strong observed Index`);
  }
});

test('sensitivity: nothing to buy when fully instrumented; nothing to move from when nothing is', () => {
  const full = computeReturnOnIntelligence(
    { firstPassAcceptance: 0.8, units: units(7, 3), matured: { realizationRate: 0.7, totalCostUsd: 10, realizedValueUsd: 7 } },
    { lift: 0.6, impact: 0.7, impactHow: 'fixture outcome signal' },
  );
  assert.equal(instrumentationPriority(full).length, 0, 'all four instrumented → empty');

  const none = computeReturnOnIntelligence({ firstPassAcceptance: null, units: [], matured: { realizationRate: 0, totalCostUsd: 0, realizedValueUsd: 0 } });
  assert.equal(instrumentationPriority(none).length, 0, 'no Index → no base to move from');
});

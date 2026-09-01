import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnOnIntelligence } from '../src/value/lenses.ts';

const results = ['proposed','accepted','committed','tested','merged','shipped','survived','clean'].map((gate) => ({ gate, verdict: 'pass' })) as any;
const report = {
  firstPassAcceptance: 1,
  units: [{ maturing: false, acceptance: 1, funnel: { realized: true, results } }],
  matured: { realizationRate: 1, totalCostUsd: 1, spendOnRealizedUnitsUsd: 1 },
};

test('Impact never self-instruments from the same gates that establish Realization', () => {
  const r = computeReturnOnIntelligence(report, { lift: 1 });
  assert.equal(r.lenses.realization.value, 1);
  assert.equal(r.lenses.impact.instrumented, false);
  assert.equal(r.lenses.impact.value, null);
  assert.equal(r.coverage, 0.75);
});

test('Impact accepts explicit orthogonal evidence and keeps its provenance', () => {
  const r = computeReturnOnIntelligence(report, { lift: 1, impact: 0.4, impactHow: 'customer exposure sample' });
  assert.equal(r.lenses.impact.instrumented, true);
  assert.equal(r.lenses.impact.value, 0.4);
  assert.equal(r.lenses.impact.how, 'customer exposure sample');
  assert.equal(r.coverage, 1);
});

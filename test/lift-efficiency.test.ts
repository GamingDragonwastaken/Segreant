/**
 * The Lift efficiency signal (src/value/liftEfficiency.ts): a content-free,
 * algorithmic behavioral signal for how cleanly AI-assisted time was used, reusing
 * already-computed Acceptance-lens data and reliability.ts's empirical-Bayes
 * shrinkage. Pins the honesty properties (uninstrumented degrades to neutral,
 * never invents a prior) and the shrinkage math itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionEfficiencySignal } from '../src/value/liftEfficiency.ts';

test('sessionEfficiencySignal: neutral (multiplier 1) when no unit has a captured Acceptance value', () => {
  const s = sessionEfficiencySignal({ unitAcceptance: [], ledgerAcceptance: 0.7 });
  assert.equal(s.multiplier, 1);
  assert.equal(s.coveredUnits, 0);
  assert.ok(s.notes[0]!.includes('uninstrumented'));

  const sAllNullish = sessionEfficiencySignal({ unitAcceptance: [null, undefined], ledgerAcceptance: 0.7 });
  assert.equal(sAllNullish.multiplier, 1);
  assert.equal(sAllNullish.coveredUnits, 0);
});

test('sessionEfficiencySignal: neutral when the ledger has no overall Acceptance rate to shrink toward', () => {
  const s = sessionEfficiencySignal({ unitAcceptance: [0.9, 0.8], ledgerAcceptance: null });
  assert.equal(s.multiplier, 1);
  assert.equal(s.coveredUnits, 0);
  assert.ok(s.notes[0]!.includes('uninstrumented'));
});

test('sessionEfficiencySignal: null/undefined entries are excluded from the pool, never treated as zero', () => {
  // Two real observations exactly at the ledger mean → shrunk rate equals the mean
  // exactly, so this also pins "no deviation ⇒ multiplier 1" in the same case.
  const s = sessionEfficiencySignal({ unitAcceptance: [0.9, null, undefined, 0.9], ledgerAcceptance: 0.9 });
  assert.equal(s.coveredUnits, 2, 'only the two real values enter the pool');
  assert.equal(s.multiplier, 1, 'observed rate matches the prior exactly, so shrinkage moves nothing');
});

test('sessionEfficiencySignal: above-prior Acceptance shrinks toward it and raises the multiplier above 1', () => {
  // k=3, n=3, prior mean 0.5, strength 20 → shrunk = (3 + 10) / 23 = 13/23.
  const s = sessionEfficiencySignal({ unitAcceptance: [1, 1, 1], ledgerAcceptance: 0.5 });
  const expectedShrunk = 13 / 23;
  const expectedMultiplier = 1 + (expectedShrunk - 0.5);
  assert.equal(s.coveredUnits, 3);
  assert.ok(Math.abs(s.multiplier - expectedMultiplier) < 1e-9);
  assert.ok(s.multiplier > 1, 'above-prior acceptance raises the discount above neutral');
  assert.ok(s.multiplier < 1.15, 'three thin observations do not saturate the cap on their own');
});

test('sessionEfficiencySignal: below-prior Acceptance shrinks toward it and lowers the multiplier below 1', () => {
  // k=0, n=3, prior mean 0.5, strength 20 → shrunk = 10/23.
  const s = sessionEfficiencySignal({ unitAcceptance: [0, 0, 0], ledgerAcceptance: 0.5 });
  const expectedShrunk = 10 / 23;
  const expectedMultiplier = 1 + (expectedShrunk - 0.5);
  assert.equal(s.coveredUnits, 3);
  assert.ok(Math.abs(s.multiplier - expectedMultiplier) < 1e-9);
  assert.ok(s.multiplier < 1, 'below-prior acceptance lowers the discount below neutral');
});

test('sessionEfficiencySignal: a thin single-unit sample is shrunk hard toward the prior (barely moves)', () => {
  // κ=20 dominates n=1: a single perfect-acceptance unit should move the rate only
  // a little, not swing it anywhere near 1.0 — proof the "thin sample" trap this
  // module exists to fix (reliability.ts's docblock) is actually being avoided.
  const s = sessionEfficiencySignal({ unitAcceptance: [1], ledgerAcceptance: 0.3 });
  // shrunk = (1 + 20*0.3) / 21 = 7/21 = 1/3
  assert.ok(Math.abs(s.multiplier - (1 + (1 / 3 - 0.3))) < 1e-9);
  assert.ok(s.multiplier < 1.05, 'one thin observation should not move the multiplier far from neutral');
});

test('sessionEfficiencySignal: the multiplier is bounded to [0.85, 1.15] even under extreme, well-evidenced deviation', () => {
  const high = sessionEfficiencySignal({
    unitAcceptance: Array.from({ length: 20 }, () => 1),
    ledgerAcceptance: 0.5,
  });
  // shrunk = (20 + 10) / 40 = 0.75 → raw multiplier 1.25, capped at 1.15.
  assert.equal(high.multiplier, 1.15);

  const low = sessionEfficiencySignal({
    unitAcceptance: Array.from({ length: 20 }, () => 0),
    ledgerAcceptance: 0.5,
  });
  // shrunk = (0 + 10) / 40 = 0.25 → raw multiplier 0.75, floored at 0.85.
  assert.equal(low.multiplier, 0.85);
});

test('sessionEfficiencySignal: notes are content-free — no proposal/commit content, only counts and rates', () => {
  const s = sessionEfficiencySignal({ unitAcceptance: [0.9, 0.6], ledgerAcceptance: 0.75 });
  assert.equal(s.notes.length, 1);
  assert.ok(s.notes[0]!.includes('2 realized unit'));
  assert.ok(s.notes[0]!.includes('75%'));
  assert.ok(s.notes[0]!.includes('content-free'));
});

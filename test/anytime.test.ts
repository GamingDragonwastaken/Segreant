import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anytimeRateInterval, logEValue } from '../src/value/anytime.ts';

/** Deterministic RNG (mulberry32) so the coverage simulation is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('anytime: interval always contains the observed rate and respects [0,1]', () => {
  for (const [k, n] of [[0, 10], [10, 10], [7, 10], [1, 200], [140, 200], [1, 1]] as Array<[number, number]>) {
    const cs = anytimeRateInterval(k, n);
    assert.ok(cs.low >= 0 && cs.high <= 1, 'inside the unit interval');
    assert.ok(cs.low <= k / n + 1e-12 && cs.high >= k / n - 1e-12, `contains k/n for ${k}/${n}`);
    assert.ok(cs.low < cs.high, 'non-degenerate');
  }
  // Boundary honesty: nothing observed → the whole interval; all-success → high = 1.
  assert.deepEqual([anytimeRateInterval(0, 0).low, anytimeRateInterval(0, 0).high], [0, 1]);
  assert.equal(anytimeRateInterval(0, 50).low, 0);
  assert.equal(anytimeRateInterval(50, 50).high, 1);
});

test('anytime: more evidence tightens, higher level widens', () => {
  const small = anytimeRateInterval(7, 10);
  const big = anytimeRateInterval(700, 1000);
  assert.ok(big.high - big.low < small.high - small.low, '100x evidence → tighter');

  const lax = anytimeRateInterval(70, 100, { level: 0.9 });
  const strict = anytimeRateInterval(70, 100, { level: 0.99 });
  assert.ok(strict.high - strict.low > lax.high - lax.low, '99% ⊃ 90%');
});

test('anytime: e-value is a fair bet — small under the truth, grows against a false rate', () => {
  // Against the true rate the e-value stays modest; against a wrong rate it explodes.
  const k = 140;
  const n = 200; // truth ≈ 0.7
  assert.ok(logEValue(k, n, 0.7) < Math.log(20), 'true rate is not rejected at 95%');
  assert.ok(logEValue(k, n, 0.3) > Math.log(1000), 'a far-off rate is overwhelmingly rejected');
});

test('anytime: SIMULTANEOUS coverage under continuous monitoring — where the classical interval fails', () => {
  // The product claim as a test. Watch a stream at EVERY step; count runs where
  // the interval ever excludes the truth. The confidence sequence must hold its
  // budget over all peeks; the classical (Wald) interval must blow through it.
  const p = 0.35;
  const alpha = 0.1; // 90%, for test power
  const runs = 400;
  const steps = 250;
  const rand = rng(20260702);

  let csViolations = 0;
  let waldViolations = 0;
  for (let r = 0; r < runs; r++) {
    // Incremental e-process at the TRUE p (p exits CSₙ ⟺ Mₙ(p) ≥ 1/α).
    let x = 0.5; // Jeffreys prior state (k + a)
    let y = 0.5; // (n − k + a)
    let logNum = 0;
    let logDen = 0;
    let k = 0;
    let csHit = false;
    let waldHit = false;
    for (let n = 1; n <= steps; n++) {
      const success = rand() < p;
      if (success) {
        logNum += Math.log(x / (x + y));
        x += 1;
        logDen += Math.log(p);
        k += 1;
      } else {
        logNum += Math.log(y / (x + y));
        y += 1;
        logDen += Math.log(1 - p);
      }
      if (logNum - logDen >= Math.log(1 / alpha)) csHit = true;
      if (n >= 10) {
        const pHat = k / n;
        const se = Math.sqrt(Math.max(pHat * (1 - pHat), 1e-12) / n);
        if (Math.abs(pHat - p) > 1.6449 * se) waldHit = true; // z for two-sided 90%
      }
    }
    if (csHit) csViolations += 1;
    if (waldHit) waldViolations += 1;
  }

  const csRate = csViolations / runs;
  const waldRate = waldViolations / runs;
  assert.ok(csRate <= alpha + 0.02, `CS holds its anytime budget: ${csRate} ≤ ~${alpha}`);
  assert.ok(waldRate > 2 * Math.max(csRate, 0.05), `classical interval fails under peeking: ${waldRate} vs CS ${csRate}`);
});

test('anytime: batch interval agrees with the incremental e-process boundary', () => {
  // The boundary returned by bisection is exactly where the e-value crosses 1/α.
  const cs = anytimeRateInterval(30, 100, { level: 0.95 });
  const t = Math.log(1 / 0.05);
  assert.ok(Math.abs(logEValue(30, 100, cs.low) - t) < 1e-6, 'low edge sits on the threshold');
  assert.ok(Math.abs(logEValue(30, 100, cs.high) - t) < 1e-6, 'high edge sits on the threshold');
  // Just inside/outside behaves correctly.
  assert.ok(logEValue(30, 100, cs.low + 1e-4) < t, 'inside is accepted');
  assert.ok(logEValue(30, 100, cs.low - 1e-4) > t, 'outside is rejected');
});

test('anytime: honest width — wider than a fixed-n interval, by design', () => {
  // The cost of "valid at every glance" is a wider interval than fixed-n Wald.
  // We assert the direction (never narrower), because narrower would be a lie.
  const k = 50;
  const n = 100;
  const cs = anytimeRateInterval(k, n, { level: 0.95 });
  const waldHalf = 1.96 * Math.sqrt(0.5 * 0.5 / n);
  assert.ok(cs.high - cs.low > 2 * waldHalf, 'anytime validity costs width; hiding that would be dishonest');
});

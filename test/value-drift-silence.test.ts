/**
 * A silent alarm is not evidence that nothing moved (WP-D06, WP-R04).
 *
 * THE DEFECT. `driftEProcess` is a genuine anytime-valid e-process: if the rate
 * really is constant, the probability that E ever reaches 1/α is at most α. That
 * guarantee runs in ONE direction. It bounds false alarms and says nothing
 * whatever about missed ones, because an e-process carries no power guarantee.
 *
 * `fiscus value` read the silence as a finding anyway, in green:
 *
 *   Stability   stable   no drift across 3 watched stream(s): ... (anytime-valid)
 *
 * printed beside `DRIFT DETECTED` in red, as though the two were symmetric
 * verdicts of one test. Only one of them is a test result. The other is the
 * absence of one, and the line states no `n`, so a reader cannot tell a quiet
 * thousand-unit history from a stream that has barely begun.
 *
 * THE COUNTEREXAMPLE, MEASURED RATHER THAN ARGUED. `rateDriftStreams` emits a
 * stream once it has `minN` observations, which defaults to 10. Run the most
 * extreme drift a binary stream can contain — a rate of 0 for the first half and
 * 1 for the second — through the same e-process the product uses:
 *
 *   n=10   alarm false   peak log E -0.693   threshold 2.996
 *   n=20   alarm false   peak log E -0.693   threshold 2.996
 *   n=40   alarm true    peak log E  5.018   threshold 2.996
 *
 * At n=10 and n=20 the evidence does not reach zero, let alone the threshold. So
 * for every stream the watch emits between 10 and roughly 30 observations, a
 * TOTAL regime change cannot fire it — and the operator was told "stable".
 *
 * WHY THIS IS THE COMPLETENESS RULE AGAIN, ONE MODULE OVER. `assessCompleteness`
 * exists precisely so that "no incident was observed" may not become "no incident
 * occurred" without positive evidence that the source could have seen one. The
 * coding `clean` gate honours it. This surface makes the identical inference from
 * the identical kind of absence, and asked for nothing.
 *
 * WHAT REPLACES IT, AND WHAT IS DELIBERATELY NOT ATTEMPTED. The honest reading of
 * a silent e-process is `unknown` — the fourth value the kernel already carries,
 * and the one the project's first rule reaches for when evidence runs out. It is
 * NOT `no drift`. No power calculation is offered either: a loose analytic bound
 * on the attainable log E admits crossings that the n=20 measurement above shows
 * are unreachable in practice, and a bound that overstates detectability would
 * reintroduce the same false comfort with a number attached. What the reading
 * carries instead is exactly what was observed: how many units, at what α, over
 * what window, and how far the evidence actually got. Recorded at D-140.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driftEProcess, driftReading, describeDriftReading } from '../src/value/drift.ts';

/** The most extreme drift a binary stream can carry: rate 0, then rate 1. */
function regimeFlip(n: number): (0 | 1)[] {
  const half = n / 2;
  return [...Array<0 | 1>(half).fill(0), ...Array<0 | 1>(half).fill(1)];
}

test('a stream the watch emits can contain a total regime change and never fire', () => {
  // THE COUNTEREXAMPLE ITSELF, pinned so a later tuning change cannot quietly
  // move it. This is a fact about the estimator's power at short lengths, not a
  // defect in it — the defect was reporting the silence as a finding.
  const short = driftEProcess(regimeFlip(20));
  assert.equal(short.alarm, false);
  assert.ok(short.maxLogE < Math.log(1 / short.alpha), 'the evidence does not approach the threshold');

  const long = driftEProcess(regimeFlip(40));
  assert.equal(long.alarm, true, 'the same estimator does fire once the stream is long enough');
});

test('a silent alarm reads as unknown, never as an absence of drift', () => {
  const reading = driftReading(driftEProcess(regimeFlip(20)));
  assert.equal(reading.state, 'unknown');
  assert.equal(reading.alarmed, false);
});

test('the reading carries what was actually observed', () => {
  const report = driftEProcess(regimeFlip(20));
  const reading = driftReading(report);
  assert.equal(reading.n, 20);
  assert.equal(reading.alpha, report.alpha);
  assert.equal(reading.window, report.window);
  // How far the evidence got, as a fraction of the threshold. Clamped at zero
  // because a negative log E means the adaptive model did worse than the
  // constant-rate one, which is not "a little bit of drift".
  assert.equal(reading.peakEvidenceFraction, 0);
  const strong = driftReading(driftEProcess(regimeFlip(40)));
  assert.ok(strong.peakEvidenceFraction >= 1, 'a crossing reaches the whole threshold');
});

test('the sentence a reader sees never asserts that nothing moved', () => {
  const words = describeDriftReading(driftReading(driftEProcess(regimeFlip(20))));
  assert.doesNotMatch(words, /\bno drift\b/i);
  assert.doesNotMatch(words, /\bstable\b/i);
  assert.doesNotMatch(words, /holding steady|steady\b/i);
  assert.match(words, /20/, 'the number of observations is part of the reading, not a footnote');
  assert.match(words, /did not|no alarm|not fire/i, 'it says what happened: the alarm did not fire');
});

test('a firing alarm is still reported as a finding', () => {
  // THE GUARD-RAIL. A change that made every reading `unknown` would satisfy the
  // assertions above and delete the alarm, which is the whole point of the watch.
  const reading = driftReading(driftEProcess(regimeFlip(40)));
  assert.equal(reading.alarmed, true);
  assert.equal(reading.state, 'supported');
  assert.match(describeDriftReading(reading), /moved|drift/i);
});

test('an empty stream is unknown for want of observations, not for want of movement', () => {
  const reading = driftReading(driftEProcess([]));
  assert.equal(reading.state, 'unknown');
  assert.equal(reading.n, 0);
  assert.match(describeDriftReading(reading), /no observations|0 /i);
});

test('the CLI no longer carries the phrasing that asserted the absence', () => {
  // A COPY REGRESSION PIN. The defect lived in one template string, and the
  // cheapest way for it to come back is someone restoring the old line because
  // it read more cleanly. Asserted against the source because the surface is
  // console output on a report that needs a seeded ledger to reach.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'valueCmd.ts'), 'utf8');
  assert.doesNotMatch(source, /no drift across/);
  assert.match(source, /describeDriftReading/, 'the CLI states the reading rather than composing its own');
});

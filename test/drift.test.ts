import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftEProcess, rateDriftStreams } from '../src/value/drift.ts';
import { GATE_LADDER, scoreFunnel, type Gate, type GateResult, type Verdict, type FunnelOutcome } from '../src/value/gates.ts';

function vr(map: Partial<Record<Gate, Verdict>>): Record<Gate, GateResult> {
  const out = {} as Record<Gate, GateResult>;
  for (const g of GATE_LADDER) out[g] = { gate: g, verdict: map[g] ?? 'unknown', detail: '' };
  return out;
}

/** Deterministic RNG (mulberry32) — the validity/power claims must be reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bern(rand: () => number, p: number, n: number): Array<0 | 1> {
  return Array.from({ length: n }, () => (rand() < p ? 1 : 0));
}

test('drift: VALIDITY — under a genuinely constant rate, the alarm respects its anytime budget', () => {
  // The trust property: watched over all of time, a stable stream trips the
  // alarm with probability ≤ α. Checked across several true rates.
  const alpha = 0.05;
  const runs = 300;
  const rand = rng(11);
  let falseAlarms = 0;
  let total = 0;
  for (const p of [0.2, 0.5, 0.8]) {
    for (let r = 0; r < runs; r++) {
      const rep = driftEProcess(bern(rand, p, 250), { alpha });
      if (rep.alarm) falseAlarms += 1;
      total += 1;
    }
  }
  const rate = falseAlarms / total;
  assert.ok(rate <= alpha + 0.02, `false-alarm rate ${rate} ≤ ~${alpha}`);
});

test('drift: POWER — an abrupt regime change is caught, with the direction visible', () => {
  const rand = rng(22);
  let caught = 0;
  const runs = 100;
  for (let r = 0; r < runs; r++) {
    const stream = [...bern(rand, 0.8, 120), ...bern(rand, 0.25, 120)]; // realization collapses mid-stream
    const rep = driftEProcess(stream, { alpha: 0.05 });
    if (rep.alarm) caught += 1;
    if (r === 0) {
      assert.ok(rep.recentRate! < rep.overallRate!, 'recent vs overall shows which way it moved');
    }
  }
  assert.ok(caught / runs >= 0.9, `abrupt drift caught in ${caught}/${runs} runs`);
});

test('drift: POWER — a slow creep of the kind a bent metric would produce is also caught', () => {
  const rand = rng(33);
  let caught = 0;
  const runs = 100;
  for (let r = 0; r < runs; r++) {
    // Acceptance creeping 0.3 → 0.9 over 300 units: the classic gamed-metric shape.
    const stream = Array.from({ length: 300 }, (_, i) => (rand() < 0.3 + (0.6 * i) / 300 ? 1 : 0) as 0 | 1);
    if (driftEProcess(stream, { alpha: 0.05 }).alarm) caught += 1;
  }
  assert.ok(caught / runs >= 0.8, `slow creep caught in ${caught}/${runs} runs`);
});

test('drift: deterministic, and honest on degenerate input', () => {
  const stream: Array<0 | 1> = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1];
  const a = driftEProcess(stream);
  const b = driftEProcess(stream);
  assert.deepEqual(a, b, 'same stream, same verdict — no randomization');

  const empty = driftEProcess([]);
  assert.equal(empty.alarm, false);
  assert.equal(empty.overallRate, null);

  const constant = driftEProcess(Array.from({ length: 200 }, () => 1 as const));
  assert.equal(constant.alarm, false, 'a perfectly stable stream never alarms');
});

test('drift: the e-value is a crossing memory — maxLogE never decreases below a past crossing', () => {
  const rand = rng(44);
  // Drift then return to the original rate: the alarm must REMEMBER the crossing
  // (an e-process crossing is a stopping event, not a mood).
  const stream = [...bern(rand, 0.8, 100), ...bern(rand, 0.2, 100), ...bern(rand, 0.8, 100)];
  const rep = driftEProcess(stream, { alpha: 0.05 });
  assert.ok(rep.maxLogE >= rep.logE, 'max is over all time');
  assert.equal(rep.alarm, true, 'the excursion is not forgotten');
});

// ---- the multi-stream drift watch ----

test('rateDriftStreams: all three streams reported when observed; coverage suppression is caught as drift', () => {
  // First 30 units: hard gates instrumented (tested pass), realized mix.
  // Next 30: hard gates silently un-wired (unknown) — the coverage stream drifts 0 → 1.
  const instrumented: FunnelOutcome[] = Array.from({ length: 30 }, (_, i) =>
    scoreFunnel(vr({ proposed: 'pass', accepted: i % 3 === 0 ? 'fail' : 'pass', committed: 'pass', tested: 'pass', merged: 'pass', shipped: 'pass', survived: 'pass', clean: 'pass' })),
  );
  const suppressed: FunnelOutcome[] = Array.from({ length: 30 }, (_, i) =>
    scoreFunnel(vr({ proposed: 'pass', accepted: i % 3 === 0 ? 'fail' : 'pass', committed: 'pass', survived: 'pass', clean: 'pass' })),
  );
  const streams = rateDriftStreams([...instrumented, ...suppressed]);
  const names = streams.map((s) => s.stream);
  assert.deepEqual(names.sort(), ['acceptance', 'hard-gate-coverage', 'realization'].sort(), 'all three streams have enough data');
  const coverage = streams.find((s) => s.stream === 'hard-gate-coverage')!;
  assert.equal(coverage.report.alarm, true, 'un-wiring the hard gates mid-stream must trip the coverage alarm');
  assert.match(coverage.reading, /coverage suppression/i, 'the alarm must carry its typical reading');
});

test('rateDriftStreams: acceptance stream uses only OBSERVED accepted verdicts; short streams are omitted, never invented', () => {
  // 12 units with observed accepted verdicts, but only 5 total units for other checks? — here:
  // acceptance observed on all 12, so acceptance + realization + coverage all have n=12.
  const outcomes: FunnelOutcome[] = Array.from({ length: 12 }, () =>
    scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass' })),
  );
  const streams = rateDriftStreams(outcomes);
  const acc = streams.find((s) => s.stream === 'acceptance');
  assert.ok(acc, 'acceptance stream present with 12 observed verdicts');
  assert.equal(acc!.report.n, 12);

  // Under 10 observed accepted verdicts → the acceptance stream is omitted.
  const thin: FunnelOutcome[] = Array.from({ length: 12 }, (_, i) =>
    scoreFunnel(vr({ proposed: 'pass', accepted: i < 5 ? 'pass' : 'unknown', committed: 'pass' })),
  );
  const thinStreams = rateDriftStreams(thin);
  assert.equal(thinStreams.find((s) => s.stream === 'acceptance'), undefined, 'only 5 observed accepted verdicts — no invented stream');
  assert.ok(thinStreams.find((s) => s.stream === 'realization'), 'realization still has its 12 outcomes');
});

/**
 * The real (non-synthetic) Lift source: TSF = baselined realized minutes /
 * measured AI minutes, fed through the METR-discounted boundedLift. These tests
 * pin the math and — most importantly — the honesty properties: it degrades to
 * uninstrumented rather than inventing a counterfactual, and it cannot be gamed
 * by spending more AI time. Also covers the optional Acceptance-driven efficiency
 * signal's end-to-end wiring (unit math lives in test/lift-efficiency.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liftFromData, timeWithAiMinutes, type AiEvent } from '../src/value/lift.ts';

function singleSessionEvents(count: number, stepMin: number, startMs = 1_000_000): AiEvent[] {
  const out: AiEvent[] = [];
  for (let i = 0; i < count; i++) out.push({ sessionId: 's1', tsEpochMs: startMs + i * stepMin * 60_000 });
  return out;
}

test('liftFromData: TSF = baselined realized minutes / measured AI minutes; interval contains point', () => {
  const baselineMinutes = { feature: 240, fix: 90 };
  const units = [
    { taskType: 'feature', realized: true }, // 240
    { taskType: 'fix', realized: true }, //      90  → 330 baselined manual min
    { taskType: 'docs', realized: true }, //     no baseline → ignored, stays honest
    { taskType: 'feature', realized: false }, //  not realized → excluded
  ];
  const events = singleSessionEvents(4, 10); // 4 distinct 10-min windows, 1 session → 40 min
  const measured = timeWithAiMinutes(events).totalMin;
  const r = liftFromData({ units, events, baselineMinutes });

  assert.equal(r.estimatedManualMinutes, 330);
  assert.equal(r.coveredUnits, 2);
  assert.ok(r.tsf !== null && Math.abs(r.tsf - 330 / measured) < 1e-9, 'TSF is the pooled ratio');
  assert.ok(r.lift !== null && r.lift > 0 && r.lift < 1, 'lens score is a real fraction');
  assert.ok(r.liftRange.low !== null && r.liftRange.high !== null);
  assert.ok(r.liftRange.low <= r.lift && r.lift <= r.liftRange.high, 'point inside the partial-ID interval');
});

test('liftFromData: uninstrumented when there is no baselined realized work', () => {
  const r = liftFromData({
    units: [{ taskType: 'feature', realized: false }, { taskType: 'unknownkind', realized: true }],
    events: singleSessionEvents(3, 10),
    baselineMinutes: { feature: 240 },
  });
  assert.equal(r.lift, null);
  assert.equal(r.tsf, null);
  assert.equal(r.coveredUnits, 0);
});

test('liftFromData: uninstrumented when there is no measured AI time', () => {
  const r = liftFromData({
    units: [{ taskType: 'feature', realized: true }],
    events: [],
    baselineMinutes: { feature: 240 },
  });
  assert.equal(r.lift, null);
  assert.equal(r.measuredAiMinutes, 0);
});

test('liftFromData: cannot be gamed — more AI time on the same realized work lowers Lift', () => {
  const baselineMinutes = { feature: 240 };
  const units = [{ taskType: 'feature', realized: true }];
  const lean = liftFromData({ units, events: singleSessionEvents(2, 10), baselineMinutes }); // ~20 measured min
  const bloated = liftFromData({ units, events: singleSessionEvents(10, 10), baselineMinutes }); // ~100 measured min

  assert.ok(lean.tsf !== null && bloated.tsf !== null);
  assert.ok(lean.tsf > bloated.tsf, 'spending more AI time for the same output drops the TSF');
  assert.ok(lean.lift !== null && bloated.lift !== null);
  assert.ok(lean.lift >= bloated.lift, 'and therefore cannot raise the Lift lens');
});

test('liftFromData: omitting acceptance/ledgerAcceptance leaves the efficiency signal neutral (backward compatible)', () => {
  const r = liftFromData({
    units: [{ taskType: 'feature', realized: true }],
    events: singleSessionEvents(4, 10),
    baselineMinutes: { feature: 240 },
  });
  assert.ok(r.notes.some((n) => n.includes('Efficiency signal uninstrumented')));
});

test('liftFromData: above-prior Acceptance (when supplied) sharpens the discounted Lift point without moving TSF', () => {
  const baselineMinutes = { feature: 240 };
  const events = singleSessionEvents(4, 10);

  const neutral = liftFromData({ units: [{ taskType: 'feature', realized: true }], events, baselineMinutes });
  const withAcceptance = liftFromData({
    units: [{ taskType: 'feature', realized: true, acceptance: 1 }],
    events,
    baselineMinutes,
    ledgerAcceptance: 0.3,
  });

  assert.ok(neutral.tsf !== null && withAcceptance.tsf !== null);
  assert.ok(
    Math.abs(neutral.tsf - withAcceptance.tsf) < 1e-9,
    'the efficiency signal discounts the point estimate, it never touches the behavioral TSF ratio itself',
  );
  assert.ok(neutral.lift !== null && withAcceptance.lift !== null);
  assert.ok(withAcceptance.lift > neutral.lift, 'above-prior first-pass acceptance raises the discounted Lift point');
  assert.ok(withAcceptance.notes.some((n) => n.includes('Efficiency signal:')));
});

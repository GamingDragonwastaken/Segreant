/**
 * Time Reclaimed — the "months of manual work in hours of AI-assisted time"
 * showcase, built on math that already exists. Honesty rules under test:
 * only realized+baselined units earn savings credit; died units and
 * unbaselined task types are counted but never credited; uninstrumented is
 * null, never zero; a genuinely slower AI run reports the honest negative.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTimeReclaimed, timeReclaimedFromStore, WORK_WEEK_MINUTES } from '../src/value/timeReclaimed.ts';
import { Store } from '../src/store/db.ts';
import type { RealizationReport } from '../src/value/realization.ts';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'fiscus-time-reclaimed-'));
}

const BASE = { feature: 240, bugfix: 90 };
const BOUNDS = { low: { feature: 180, bugfix: 60 }, high: { feature: 300, bugfix: 120 } };

test('time reclaimed: only realized+baselined units earn credit; died units are counted, never credited', () => {
  const r = computeTimeReclaimed(
    [
      { taskType: 'feature', realized: true, attributedCostUsd: 10 },
      { taskType: 'feature', realized: true, attributedCostUsd: 5 },
      { taskType: 'feature', realized: false, attributedCostUsd: 20 }, // died: time in denominator, zero credit
      { taskType: 'bugfix', realized: true, attributedCostUsd: 2 },
      { taskType: 'docs', realized: true, attributedCostUsd: 1 },      // realized but NO baseline → uncredited
    ],
    120, // 2 measured AI hours
    BASE,
    BOUNDS,
  );
  assert.equal(r.manualMinutes, 240 * 2 + 90);           // 570
  assert.equal(r.manualMinutesLow, 180 * 2 + 60);        // 420
  assert.equal(r.manualMinutesHigh, 300 * 2 + 120);      // 720
  assert.equal(r.savedMinutes, 570 - 120);               // 450
  assert.deepEqual(r.savedRange, { low: 300, high: 600 });
  assert.equal(r.workWeeksSaved, 450 / WORK_WEEK_MINUTES);
  assert.equal(r.uncreditedUnits, 2);                    // 1 died + 1 unbaselined
  const feat = r.strata.find((s) => s.taskType === 'feature')!;
  assert.equal(feat.realizedUnits, 2);
  assert.equal(feat.diedUnits, 1);
  assert.equal(feat.costUsd, 35);
  const docs = r.strata.find((s) => s.taskType === 'docs')!;
  assert.equal(docs.baselined, false);
  assert.equal(docs.manualMinutes, 0, 'no baseline → no invented credit');
  assert.ok(r.notes.some((n) => /no savings credit/i.test(n)), 'the uncredited split is disclosed');
});

test('time reclaimed: uninstrumented is null, never zero — and never negative-suppressed', () => {
  const empty = computeTimeReclaimed([], 120, BASE, BOUNDS);
  assert.equal(empty.savedMinutes, null);
  assert.equal(empty.workWeeksSaved, null);
  const noTime = computeTimeReclaimed([{ taskType: 'feature', realized: true, attributedCostUsd: 1 }], 0, BASE);
  assert.equal(noTime.savedMinutes, null, 'no measured AI time → no claim');
  // AI took LONGER than the baseline: report the honest negative, don't clamp.
  const slower = computeTimeReclaimed([{ taskType: 'bugfix', realized: true, attributedCostUsd: 1 }], 600, BASE);
  assert.equal(slower.savedMinutes, 90 - 600);
});

test('timeReclaimedFromStore: measures AI minutes over the full matured-unit window and feeds computeTimeReclaimed', () => {
  const dir = makeRoot();
  try {
    const store = new Store(join(dir, 'aegis.db'));
    store.insertRequest({
      requestId: 'r1', sessionId: 's1', tsEpochMs: 0, provider: 'anthropic', model: 'm', project: 'p',
      taskWeight: 1, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: 0.01, estimated: false, streamed: false, statusCode: 200, durationMs: 100,
    });
    store.insertRequest({
      requestId: 'r2', sessionId: 's1', tsEpochMs: 300_000, provider: 'anthropic', model: 'm', project: 'p',
      taskWeight: 1, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: 0.01, estimated: false, streamed: false, statusCode: 200, durationMs: 100,
    });
    const report = {
      units: [
        { taskType: 'feature', attributedCostUsd: 5, maturing: false, funnel: { realized: true }, windowStartMs: 0, windowEndMs: 600_000 },
      ],
    } as unknown as RealizationReport;
    const r = timeReclaimedFromStore(store, report, BASE, BOUNDS);
    assert.ok(r.aiMinutes > 0, 'measured AI minutes over the matured-unit span');
    assert.equal(r.manualMinutes, 240);
    assert.ok(r.savedMinutes !== null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

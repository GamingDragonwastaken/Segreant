/**
 * Codex review 2026-10-16, finding 3: in a zone whose clocks jump at midnight
 * (Cairo, 24 April 2026, 00:00 -> 01:00), every day after the jump must still
 * have its own bucket. Generated buckets used to keep the 01:00 hour, while
 * requests were keyed to 00:00, so later days fell out of the chart.
 */
process.env.TZ = 'Africa/Cairo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { buildSessions } from '../src/dashboard/sessions.ts';

let seq = 0;
function req(ts: number): RequestRow {
  seq += 1;
  return {
    requestId: `r${seq}`, sessionId: 's', tsEpochMs: ts, provider: 'anthropic', model: 'm', project: 'p', taskWeight: 1,
    inputTokens: 10, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

test('a midnight clock change does not drop the days after it from the chart', () => {
  const store = new Store(':memory:');
  try {
    for (let d = 22; d <= 26; d += 1) store.insertRequest(req(new Date(2026, 3, d, 12).getTime()));
    const start = new Date(2026, 3, 22).getTime();
    const end = new Date(2026, 3, 27).getTime();
    const p = buildSessions(store, '7d', { startMs: start, endMs: end, bucketMs: 24 * 60 * 60 * 1000 }, { now: end - 1 });
    const charted = p.buckets.reduce((s, b) => s + b.costUsd, 0);
    assert.equal(p.totals.costUsd, 5);
    assert.equal(charted, 5, 'every day is in a bucket');
    for (const b of p.buckets) {
      const d = new Date(b.startMs);
      assert.equal(d.getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), 'each bucket starts at its own local midnight');
    }
  } finally { store.close(); }
});

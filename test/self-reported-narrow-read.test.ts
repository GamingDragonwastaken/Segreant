import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { recordReportedOutcome, selfReportedValueReport } from '../src/value/selfReported.ts';

// The self-reported report matched operator outcomes to spend by reading every
// request ever recorded and filtering in memory. On a 300,000-request ledger
// that one read took /api/value from about 320 MiB of heap to 864 MiB (1.26 GiB
// RSS), on a ledger with no self-reported outcome at all. Spend is now read per
// link. These tests pin both halves: the matched spend is exactly what the
// all-history filter gave, and no reader loads the ledger wholesale.

const at = Date.parse('2026-09-27T10:00:00.000Z');
const row = (requestId: string, tsEpochMs: number, costUsd: number, opts: { sessionId?: string | null; source?: string | null; model?: string } = {}) => ({
  requestId, sessionId: opts.sessionId === undefined ? 's1' : opts.sessionId, tsEpochMs, provider: 'openai', model: opts.model ?? 'model-a',
  project: 'p', taskWeight: 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
  costUsd, estimated: true, streamed: false, statusCode: 200, durationMs: 1, source: opts.source === undefined ? 'chat-tool' : opts.source,
});

function seeded(): Store {
  const store = new Store(':memory:');
  // Session s1: one row long before the report window (still counts: a session
  // may start before the window), one inside it, one exactly at the window end
  // (excluded: the end is exclusive), one after it.
  store.insertRequest(row('s1-old', at - 30 * 86_400_000, 1));
  store.insertRequest(row('s1-in', at, 2));
  store.insertRequest(row('s1-end', at + 10_000, 4));
  store.insertRequest(row('s1-after', at + 20_000, 8));
  // Other sessions and tools that must never match.
  store.insertRequest(row('s2-in', at, 16, { sessionId: 's2', source: 'video-tool', model: 'model-b' }));
  store.insertRequest(row('nosession', at + 1, 32, { sessionId: null, source: null }));
  // Window link on image-tool: inside, at its own lower bound (included), at its
  // upper bound (excluded), and in range but from another tool.
  store.insertRequest(row('img-lo', at - 1000, 64, { sessionId: 's3', source: 'image-tool', model: 'model-b' }));
  store.insertRequest(row('img-hi', at + 1000, 128, { sessionId: 's3', source: 'image-tool', model: 'model-b' }));
  store.insertRequest(row('chat-in-window', at - 500, 256, { sessionId: 's4', source: 'chat-tool' }));
  return store;
}

const recorded = (sessionId: string) => ({ type: 'session' as const, sessionId, basis: 'recorded' as const });

test('self-reported spend per link equals the all-history filter at every boundary', () => {
  const store = seeded();
  try {
    const t = at + 5_000;
    recordReportedOutcome(store, { outcomeId: 'sess', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is', use: 'copied' }, true, true, t);
    recordReportedOutcome(store, { outcomeId: 'one', kind: 'chat', link: { type: 'request', requestId: 's1-in', basis: 'recorded' }, decision: 'accepted_as_is', use: 'copied' }, true, true, t);
    recordReportedOutcome(store, { outcomeId: 'late', kind: 'chat', link: { type: 'request', requestId: 's1-after', basis: 'recorded' }, decision: 'accepted_as_is', use: 'copied' }, true, true, t);
    recordReportedOutcome(store, { outcomeId: 'pic', kind: 'image', link: { type: 'window', fromMs: at - 1000, toMs: at + 1000, tool: 'image-tool', basis: 'inferred' }, decision: 'accepted_as_is', use: 'exported' }, true, true, t);
    const report = selfReportedValueReport(store, at, at + 10_000);
    const unit = (id: string) => report.units.find((u) => u.outcomeId === id)!;
    // s1 up to the window end: s1-old and s1-in. s1-in is also claimed by 'one',
    // so its $2 is split between the two outcomes.
    assert.equal(unit('sess').matchedRequests, 2);
    assert.equal(unit('sess').attributedCostUsd, 1 + 2 / 2);
    assert.equal(unit('one').matchedRequests, 1);
    assert.equal(unit('one').attributedCostUsd, 2 / 2);
    // A request recorded after the window end is not this window's spend.
    assert.equal(unit('late').matchedRequests, 0);
    assert.equal(unit('late').attributedCostUsd, null);
    // [fromMs, toMs) on the tool only.
    assert.equal(unit('pic').matchedRequests, 1);
    assert.equal(unit('pic').attributedCostUsd, 64);
    assert.equal(unit('pic').model, 'model-b');
    assert.equal(report.unlinkedOutcomes, 1);

    // The record preview matches over all history, so the late row counts there.
    const preview = recordReportedOutcome(store, { outcomeId: 'late2', kind: 'chat', link: { type: 'request', requestId: 's1-after', basis: 'recorded' }, decision: 'accepted_as_is' }, false, true, t);
    assert.equal(preview.matchedRequests, 1);
    assert.equal(preview.matchedCostUsd, 8);
    const sessionPreview = recordReportedOutcome(store, { outcomeId: 'sess2', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is' }, false, true, t);
    assert.equal(sessionPreview.matchedRequests, 4);
    assert.equal(sessionPreview.matchedCostUsd, 1 + 2 + 4 + 8);
  } finally { store.close(); }
});

test('neither the report nor the record preview reads the whole request ledger', () => {
  const store = seeded();
  let wholesale = 0;
  const original = store.requestsInRange.bind(store);
  store.requestsInRange = (startMs: number, endMs: number) => { wholesale += 1; return original(startMs, endMs); };
  try {
    // No outcome recorded: the common case, and the one that cost 540 MiB.
    const empty = selfReportedValueReport(store, at, at + 10_000);
    assert.equal(empty.units.length, 0);
    recordReportedOutcome(store, { outcomeId: 'sess', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is' }, true, true, at + 5_000);
    const report = selfReportedValueReport(store, at, at + 10_000);
    assert.equal(report.units[0]?.matchedRequests, 2);
    assert.equal(wholesale, 0, 'requestsInRange read the ledger to match self-reported spend');
  } finally { store.close(); }
});

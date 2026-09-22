/**
 * buildStructuralSummary (src/judge/payload.ts): pure row-shaping math, plus the
 * one property that matters most — the summary can only ever contain counts,
 * gaps, and token totals, never any field that could carry code or prose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStructuralSummary } from '../src/judge/payload.ts';
import type { RequestRow, ProposalRow } from '../src/store/db.ts';

function req(overrides: Partial<RequestRow>): RequestRow {
  return {
    requestId: 'r',
    sessionId: 's1',
    tsEpochMs: 0,
    provider: 'anthropic',
    model: 'claude',
    project: 'p',
    taskWeight: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 500,
    ...overrides,
  };
}

function prop(overrides: Partial<ProposalRow>): ProposalRow {
  return {
    proposalId: 'p1',
    requestId: 'r',
    sessionId: 's1',
    tsEpochMs: 0,
    provider: 'anthropic',
    model: 'claude',
    project: 'p',
    files: [{ path: 'a.ts', addedLines: ['x'] }],
    ...overrides,
  };
}

test('buildStructuralSummary: filters both requests and proposals to the given sessionId', () => {
  const requests = [
    req({ requestId: 'r1', sessionId: 's1', tsEpochMs: 1000 }),
    req({ requestId: 'r2', sessionId: 's1', tsEpochMs: 2000 }),
    req({ requestId: 'r3', sessionId: 's2', tsEpochMs: 1500 }), // other session, must be excluded
  ];
  const proposals = [prop({ sessionId: 's1' }), prop({ sessionId: 's1' }), prop({ sessionId: 's2' })];
  const summary = buildStructuralSummary(requests, proposals, 's1');
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.proposalCount, 2);
  assert.equal(summary.proposalCaptureCoverage, 'complete');
});

test('buildStructuralSummary: truncated proposal capture is disclosed and cannot count as a complete proposal', () => {
  const summary = buildStructuralSummary(
    [req({ sessionId: 's1' })],
    [prop({ captureCoverage: 'truncated' })],
    's1',
  );
  assert.equal(summary.proposalCount, 0);
  assert.equal(summary.proposalCaptureCoverage, 'truncated');
});

test('buildStructuralSummary: inter-turn gaps are chronological deltas in seconds, n-1 for n requests', () => {
  const requests = [
    req({ tsEpochMs: 0 }),
    req({ tsEpochMs: 30_000 }), // +30s
    req({ tsEpochMs: 90_000 }), // +60s
  ];
  const summary = buildStructuralSummary(requests, [], 's1');
  assert.deepEqual(summary.interTurnGapsSec, [30, 60]);
});

test('buildStructuralSummary: sorts out-of-order rows before computing gaps (never trusts input order)', () => {
  const requests = [req({ tsEpochMs: 90_000 }), req({ tsEpochMs: 0 }), req({ tsEpochMs: 30_000 })];
  const summary = buildStructuralSummary(requests, [], 's1');
  assert.deepEqual(summary.interTurnGapsSec, [30, 60]);
});

test('buildStructuralSummary: requestSizeTrend is input+output tokens per request, chronological', () => {
  const requests = [
    req({ tsEpochMs: 2000, inputTokens: 300, outputTokens: 100 }),
    req({ tsEpochMs: 1000, inputTokens: 100, outputTokens: 50 }),
  ];
  const summary = buildStructuralSummary(requests, [], 's1');
  assert.deepEqual(summary.requestSizeTrend, [150, 400]);
});

test('buildStructuralSummary: zero or one request never divides by zero (empty gaps, zero span)', () => {
  const empty = buildStructuralSummary([], [], 's1');
  assert.equal(empty.requestCount, 0);
  assert.deepEqual(empty.interTurnGapsSec, []);
  assert.equal(empty.spanMinutes, 0);

  const one = buildStructuralSummary([req({ tsEpochMs: 5000 })], [], 's1');
  assert.equal(one.requestCount, 1);
  assert.deepEqual(one.interTurnGapsSec, []);
  assert.equal(one.spanMinutes, 0);
});

test('buildStructuralSummary: totalCostUsd sums only the target session\'s requests', () => {
  const requests = [
    req({ sessionId: 's1', costUsd: 0.1 }),
    req({ sessionId: 's1', costUsd: 0.2 }),
    req({ sessionId: 's2', costUsd: 100 }),
  ];
  const summary = buildStructuralSummary(requests, [], 's1');
  assert.ok(Math.abs(summary.totalCostUsd - 0.3) < 1e-9);
});

test('buildStructuralSummary: the returned shape has no field capable of carrying prompt or code text', () => {
  const summary = buildStructuralSummary([req({})], [prop({})], 's1');
  const keys = Object.keys(summary);
  assert.deepEqual(
    keys.sort(),
    ['interTurnGapsSec', 'proposalCaptureCoverage', 'proposalCount', 'requestCount', 'requestSizeTrend', 'sessionId', 'spanMinutes', 'totalCostUsd'].sort(),
  );
});

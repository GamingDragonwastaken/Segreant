import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { recordReportedOutcome, selfReportedValueReport, SELF_REPORTED_BASIS } from '../src/value/selfReported.ts';
import { evaluateReportedLadder } from '../src/value/usage.ts';

const at = Date.parse('2026-09-27T10:00:00.000Z');
const request = (requestId: string, sessionId: string, model: string, costUsd: number, source = 'chat-tool') => ({
  requestId, sessionId, tsEpochMs: at, provider: 'openai', model, project: 'p', taskWeight: 1,
  inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
  costUsd, estimated: true, streamed: false, statusCode: 200, durationMs: 1, source,
});
const recorded = (sessionId: string) => ({ type: 'session' as const, sessionId, basis: 'recorded' as const });

test('self-reported ladder retains unknown instead of promoting it to pass or fail', () => {
  const ladder = evaluateReportedLadder('answer-1', 'chat', [
    { type: 'rating', value: 5, source: 'operator', observedAtMs: at },
  ]);
  assert.deepEqual([ladder.produced, ladder.reviewed, ladder.accepted, ladder.used, ladder.stillInUse],
    ['pass', 'pass', 'unknown', 'unknown', 'unknown']);
  assert.equal(ladder.basis, 'self-reported');
});

test('preview does not write; apply appends timestamped operator signals and later durability update', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r1', 's1', 'gpt-image-1', 2));
    const input = { outcomeId: 'image-1', kind: 'image' as const, link: recorded('s1'), rating: 4, note: 'usable', decision: 'edited_before_use' as const, attempts: 2, regenerated: true, use: 'published' as const };
    const preview = recordReportedOutcome(store, input, false, true, at + 1000);
    assert.equal(preview.apply, false);
    assert.equal(store.selfReportedOutcomeSignals(0, at + 2000).length, 0);
    assert.equal(preview.matchedCostUsd, 2);
    recordReportedOutcome(store, input, true, true, at + 1000);
    recordReportedOutcome(store, { outcomeId: 'image-1', kind: 'image', link: recorded('s1'), stillInUse: true }, true, true, at + 2000);
    const report = selfReportedValueReport(store, at - 1, at + 3000);
    assert.equal(report.units[0]?.ladder.stillInUse, 'pass');
    // rating (with note), decision, regenerated, attempts, use; then still_in_use.
    assert.equal(report.units[0]?.signals.length, 6);
    assert.ok(report.units[0]?.signals.every((signal) => signal.source === 'operator' && signal.observedAtMs >= at + 1000));
    assert.equal(report.byKind[0]?.costPerAcceptedUsd, 2);
    assert.equal(report.byKind[0]?.costPerUsedUsd, 2);
  } finally { store.close(); }
});

test('inferred links stay inferred and unmatched spend withholds unit economics', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r1', 's1', 'model-a', 3, 'image-tool'));
    recordReportedOutcome(store, { outcomeId: 'picture', kind: 'image',
      link: { type: 'window', fromMs: at - 1000, toMs: at + 1000, tool: 'image-tool', basis: 'inferred' },
      decision: 'accepted_as_is', use: 'exported' }, true, true, at + 1000);
    recordReportedOutcome(store, { outcomeId: 'missing', kind: 'chat', link: recorded('missing'),
      decision: 'accepted_as_is', use: 'copied' }, true, true, at + 1000);
    const report = selfReportedValueReport(store, at - 1, at + 3000);
    assert.equal(report.inferredLinks, 1);
    assert.equal(report.units.find((u) => u.outcomeId === 'picture')?.link.basis, 'inferred');
    assert.equal(report.units.find((u) => u.outcomeId === 'missing')?.attributedCostUsd, null);
    assert.equal(report.byKind.find((c) => c.key === 'chat')?.costPerAcceptedUsd, null);
  } finally { store.close(); }
});

test('every self-reported output carries its basis and coding outcomes are excluded from the denominator', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(request('r1', 's1', 'model-a', 4));
    store.insertSignal({ signalId: 'coding', kind: 'tested', commitHash: 'deadbeef', project: 'p', tsEpochMs: at, verdict: 'pass', detail: null, evidenceSource: 'signed-ci' });
    recordReportedOutcome(store, { outcomeId: 'answer', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is', use: 'copied' }, true, true, at + 1);
    const report = selfReportedValueReport(store, at - 1, at + 2000);
    assert.equal(report.basis, SELF_REPORTED_BASIS);
    assert.equal(report.codingComparison, 'separate_basis');
    assert.equal(report.units.length, 1);
    assert.ok(report.units.every((u) => u.basis === SELF_REPORTED_BASIS));
    assert.ok([...report.byKind, ...report.byModel].every((cell) => cell.basis === SELF_REPORTED_BASIS));
    assert.equal(report.byModel[0]?.costPerAcceptedUsd, 4);
  } finally { store.close(); }
});

test('local dashboard refuses unguarded writes and enforces preview then apply semantics', async () => {
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = JSON.stringify({ outcomeId: 'chat-1', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is', apply: false });
  try {
    const denied = await fetch(base + '/api/outcome/record', { method: 'POST', body });
    assert.equal(denied.status, 403);
    const preview = await fetch(base + '/api/outcome/record', { method: 'POST', headers: { 'x-segreant-local': '1' }, body });
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { apply: boolean }).apply, false);
    assert.equal(store.selfReportedOutcomeSignals(0, Number.MAX_SAFE_INTEGER).length, 0);
    const applied = await fetch(base + '/api/outcome/record', { method: 'POST', headers: { 'x-segreant-local': '1' }, body: body.replace('\"apply\":false', '\"apply\":true') });
    assert.equal(applied.status, 200);
    assert.equal(((await applied.json()) as { apply: boolean }).apply, true);
    assert.equal(store.selfReportedOutcomeSignals(0, Number.MAX_SAFE_INTEGER).length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('a disabled report says disabled instead of presenting an empty result', () => {
  const store = new Store(':memory:');
  try {
    recordReportedOutcome(store, { outcomeId: 'a', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is' }, true, true, at);
    const report = selfReportedValueReport(store, at - 1, at + 1000, false);
    assert.equal(report.status, 'disabled');
    assert.equal(selfReportedValueReport(store, at - 1, at + 1000).status, 'available');
  } finally { store.close(); }
});

test('spend a linked session made before the report window still counts toward its outcome', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest({ ...request('early', 's1', 'model-a', 3), tsEpochMs: at - 2 * 86400000 });
    store.insertRequest(request('late', 's1', 'model-a', 1));
    recordReportedOutcome(store, { outcomeId: 'o', kind: 'chat', link: recorded('s1'), decision: 'accepted_as_is' }, true, true, at + 10);
    const report = selfReportedValueReport(store, at - 1000, at + 1000);
    assert.equal(report.units[0]?.attributedCostUsd, 4);
    assert.equal(report.byKind[0]?.costPerAcceptedUsd, 4);
  } finally { store.close(); }
});

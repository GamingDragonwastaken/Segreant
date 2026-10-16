/**
 * The Workbench read: sessions, buckets by model, and what each session's
 * commits came to. Every total must equal an independent count of the rows,
 * a commit is linked only by the session's own log, and context figures leave
 * out requests whose usage was never reported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { buildSessions, foldProfile, contextTokens } from '../src/dashboard/sessions.ts';
import { realizationFromStore, keptBucketOf } from '../src/value/realization.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 16, 15).getTime();
let seq = 0;

function req(over: Partial<RequestRow>): RequestRow {
  seq += 1;
  return {
    requestId: `r${seq}`, sessionId: 's1', tsEpochMs: NOW - DAY, provider: 'anthropic', model: 'claude-sonnet-5-5',
    project: 'app', taskWeight: 1, inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.1, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    ...over,
  };
}

const WEEK = { startMs: NOW - 7 * DAY, endMs: NOW + 1000, bucketMs: DAY };

test('totals, buckets and sessions each add up to the rows', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const rows = store.requestsInRange(WEEK.startMs, WEEK.endMs);
    const p = buildSessions(store, '7d', WEEK, { now: NOW });
    const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
    const near = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);

    assert.equal(p.totals.requests, rows.length);
    near(p.totals.costUsd, sum(rows.map((r) => r.costUsd)), 'total cost');
    near(sum(p.buckets.map((b) => b.costUsd)), p.totals.costUsd, 'buckets cover every row');
    for (const b of p.buckets) near(sum(b.byModel.map((m) => m.costUsd)) + b.otherUsd, b.costUsd, 'a bucket is its named models plus the rest');
    assert.equal(p.totals.sessions, new Set(rows.filter((r) => r.sessionId).map((r) => r.sessionId)).size);
    assert.equal(p.totals.unsessionedRequests, rows.filter((r) => !r.sessionId).length);
    near(sum(p.sessions.map((s) => s.costUsd)) + p.totals.unsessionedCostUsd, p.totals.costUsd, 'sessions plus unsessioned is the total');
    assert.ok(p.models.length <= 5);
    for (const b of p.buckets) for (const m of b.byModel) assert.ok(p.models.includes(m.model), 'byModel names only the five');
    for (let i = 1; i < p.sessions.length; i += 1) assert.ok(p.sessions[i - 1]!.startMs >= p.sessions[i]!.startMs, 'newest first');

    const o = p.outcomes;
    near(o.kept.costUsd + o.notKept.costUsd + o.contested.costUsd + o.unknown.costUsd + o.maturing.costUsd + o.unmeasured.costUsd + o.noCommit.costUsd,
      sum(p.sessions.map((s) => s.costUsd)), 'every session dollar lands in exactly one outcome');
    assert.match(o.basis, /splits its cost evenly/);
  } finally { store.close(); }
});

test('a week of days has one bucket per local day, and today steps by hour', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ tsEpochMs: NOW - 6 * DAY }));
    const week = buildSessions(store, '7d', WEEK, { now: NOW });
    assert.ok(week.buckets.length >= 7 && week.buckets.length <= 8, `${week.buckets.length} buckets`);
    for (const b of week.buckets) assert.equal(new Date(b.startMs).getHours(), 0, 'each bucket starts at local midnight');
    const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
    const today = buildSessions(store, 'today', { startMs: midnight.getTime(), endMs: NOW + 1000, bucketMs: 60 * 60 * 1000 }, { now: NOW });
    assert.equal(today.window.bucketMs, 60 * 60 * 1000);
    assert.equal(today.buckets.length, new Date(NOW).getHours() + 1);
  } finally { store.close(); }
});

test('context runs first to last over measured requests; refusals and failures are marked where they fell', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ tsEpochMs: NOW - 3000, inputTokens: 2000, cacheReadTokens: 0 }));
    store.insertRequest(req({ tsEpochMs: NOW - 2000, inputTokens: 500, cacheReadTokens: 30_000, statusCode: 429 }));
    store.insertRequest(req({ tsEpochMs: NOW - 1500, inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: true, statusCode: 502 }));
    store.insertRequest(req({ tsEpochMs: NOW - 1000, inputTokens: 800, cacheReadTokens: 60_000, cacheWriteTokens: 1200 }));
    const s = buildSessions(store, '7d', WEEK, { now: NOW }).sessions[0]!;
    assert.equal(s.requests, 4);
    assert.equal(s.usageUnknownRequests, 0, 'a failed reply with no tokens sent nothing; it is not missing usage');
    assert.equal(s.contextStartTokens, 2000);
    assert.equal(s.contextEndTokens, 62_000, 'the last REPORTED request, not the unreported failure');
    assert.equal(s.contextPeakTokens, 62_000);
    assert.deepEqual(s.profile, [2000, 30_500, 62_000], 'the unreported request is not drawn as a drop to zero');
    assert.deepEqual(s.marks, [{ at: 1, kind: 'refused' }, { at: 1, kind: 'failed' }], 'each lands on the point just before it');
    assert.equal(s.refusedReplies, 1);
    assert.equal(s.failedReplies, 1);
  } finally { store.close(); }
});

test('a cap refusal with no tokens is counted but sent no context', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ tsEpochMs: NOW - 3000, inputTokens: 4000 }));
    store.insertRequest(req({ tsEpochMs: NOW - 2000, inputTokens: 0, outputTokens: 0, costUsd: 0, statusCode: 429, durationMs: 0 }));
    store.insertRequest(req({ tsEpochMs: NOW - 1000, inputTokens: 5000 }));
    const s = buildSessions(store, '7d', WEEK, { now: NOW }).sessions[0]!;
    assert.deepEqual(s.profile, [4000, 5000]);
    assert.equal(s.contextEndTokens, 5000);
    assert.deepEqual(s.marks, [{ at: 0, kind: 'refused' }]);
    assert.equal(s.usageUnknownRequests, 0, 'a refusal reported its usage: there was none');
  } finally { store.close(); }
});

test('a long session folds to forty points that keep its peak', () => {
  const values = Array.from({ length: 333 }, (_, i) => (i === 200 ? 999_999 : i));
  const { profile, sliceOf } = foldProfile(values);
  assert.equal(profile.length, 40);
  assert.equal(Math.max(...profile), 999_999);
  assert.equal(sliceOf(0), 0);
  assert.equal(sliceOf(332), 39);
  assert.equal(contextTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 6);
});

test('a commit is linked only by the session log, and filed by the Statement rule', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const units = realizationFromStore(store).units;
    const settled = units.find((u) => !u.maturing)!;
    const young = units.find((u) => u.maturing)!;
    store.insertRequest(req({ sessionId: 'linked', tsEpochMs: NOW - 5000, costUsd: 3 }));
    store.insertRequest(req({ sessionId: 'unlinked', tsEpochMs: NOW - 4000, costUsd: 2 }));
    store.recordObservedCommit({ source: 'claude-code', sessionId: 'linked', shortSha: settled.hash, branch: 'main', subject: 's', tsEpochMs: NOW - 4500, cwd: null });
    store.recordObservedCommit({ source: 'claude-code', sessionId: 'linked', shortSha: young.hash, branch: 'main', subject: 'y', tsEpochMs: NOW - 4400, cwd: null });
    store.recordObservedCommit({ source: 'claude-code', sessionId: 'linked', shortSha: 'abc1234', branch: 'main', subject: 'never measured', tsEpochMs: NOW - 4300, cwd: null });
    const p = buildSessions(store, '7d', WEEK, { now: NOW });
    const linked = p.sessions.find((s) => s.sessionId === 'linked')!;
    assert.deepEqual(linked.commits.map((c) => c.outcome), [keptBucketOf(settled), 'maturing', 'unmeasured']);
    assert.ok(linked.commits[1]!.checkMs !== null, 'a young commit says when it will be checked');
    assert.equal(linked.commits[0]!.checkMs, null);
    assert.equal(p.sessions.find((s) => s.sessionId === 'unlinked')!.commits.length, 0);
    assert.ok(p.outcomes.unmeasured.costUsd >= 1 - 1e-9, 'a third of the linked session lands in unmeasured');
  } finally { store.close(); }
});

test('a demo-style hash is matched exactly, never as a prefix of a longer one', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const units = realizationFromStore(store).units;
    const one = units.find((u) => u.hash === 'demo-commit-1');
    if (!one) return; // the sample has no such unit; nothing to confuse
    store.insertRequest(req({ sessionId: 'x', tsEpochMs: NOW - 5000 }));
    store.recordObservedCommit({ source: 'opencode', sessionId: 'x', shortSha: 'demo-commit-1', branch: 'main', subject: 's', tsEpochMs: NOW - 4500, cwd: null });
    const c = buildSessions(store, '7d', WEEK, { now: NOW }).sessions.find((s) => s.sessionId === 'x')!.commits[0]!;
    assert.equal(c.outcome, keptBucketOf(one));
  } finally { store.close(); }
});

test('an empty ledger returns empty, well-formed figures', () => {
  const store = new Store(':memory:');
  try {
    const p = buildSessions(store, '7d', WEEK, { now: NOW });
    assert.equal(p.totals.requests, 0);
    assert.equal(p.sessions.length, 0);
    assert.equal(p.outcomes.measuredAt, null);
    assert.match(p.outcomes.basis, /none has run/);
    assert.ok(p.buckets.every((b) => b.costUsd === 0));
  } finally { store.close(); }
});

test('sessions past the limit are counted, not listed', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 5; i += 1) store.insertRequest(req({ sessionId: `s${i}`, tsEpochMs: NOW - (i + 1) * 1000 }));
    const p = buildSessions(store, '7d', WEEK, { now: NOW, sessionLimit: 3 });
    assert.equal(p.sessions.length, 3);
    assert.equal(p.sessionsOmitted, 2);
    assert.equal(p.totals.sessions, 5);
  } finally { store.close(); }
});

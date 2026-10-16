/**
 * Codex review 2026-10-16 (PRs #121-#124), the Workbench findings, each pinned
 * by the input that broke it: an ambiguous abbreviated sha, a price estimate
 * read as missing usage, a model named "other", an equal split that lost a
 * microdollar on the wire, a per-unit window ignored by the next-check date,
 * and a commit scan that grew with the square of the history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { buildSessions } from '../src/dashboard/sessions.ts';
import { realizationFromStore, keptSummary } from '../src/value/realization.ts';
import { stringifyJson } from '../src/util/json.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 16, 15).getTime();
const WEEK = { startMs: NOW - 7 * DAY, endMs: NOW + 1000, bucketMs: DAY };
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

/** A settled, kept unit copied from the sample, so every field is real. */
function sampleUnits(): { kept: Record<string, unknown>; notKept: Record<string, unknown> } {
  const seeded = new Store(':memory:');
  try {
    seedDemo(seeded);
    const units = realizationFromStore(seeded).units;
    const kept = units.find((u) => !u.maturing && !u.reverted && u.funnel.conflicts.length === 0 && u.funnel.results.every((r) => r.verdict !== 'fail'));
    const notKept = units.find((u) => !u.maturing && u.reverted);
    assert.ok(kept && notKept);
    return { kept: JSON.parse(JSON.stringify(kept)), notKept: JSON.parse(JSON.stringify(notKept)) };
  } finally { seeded.close(); }
}

function storeUnit(store: Store, base: Record<string, unknown>, hash: string, over: Record<string, unknown> = {}): void {
  const unit: Record<string, unknown> = { ...base, hash, ...over };
  store.saveRealizationUnits([{
    commitHash: hash, project: String(unit['project'] ?? 'p'), tsEpochMs: Number(unit['tsEpochMs']),
    computedAtMs: Date.now(), attributedCostUsd: Number(unit['attributedCostUsd'] ?? 1), maturing: Boolean(unit['maturing']),
    realized: false, unitJson: JSON.stringify(unit), costScope: 'window',
  }]);
}

test('an abbreviated sha that two measured commits share is not matched to either', () => {
  const store = new Store(':memory:');
  try {
    const { kept, notKept } = sampleUnits();
    storeUnit(store, notKept, `abcdef0${'1'.repeat(33)}`);
    storeUnit(store, kept, `abcdef0${'2'.repeat(33)}`);
    storeUnit(store, kept, `1234567${'3'.repeat(33)}`);
    store.insertRequest(req({ sessionId: 'x', tsEpochMs: NOW - 5000 }));
    store.recordObservedCommit({ source: 't', sessionId: 'x', shortSha: 'abcdef0', branch: 'main', subject: 'a', tsEpochMs: NOW - 4000, cwd: null });
    store.recordObservedCommit({ source: 't', sessionId: 'x', shortSha: '1234567', branch: 'main', subject: 'b', tsEpochMs: NOW - 3000, cwd: null });
    const s = buildSessions(store, '7d', WEEK, { now: NOW }).sessions[0]!;
    assert.deepEqual(s.commits.map((c) => c.outcome), ['unmeasured', 'kept'], 'the unique abbreviation still matches');
  } finally { store.close(); }
});

test('a request priced by estimate still reports its context', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ tsEpochMs: NOW - 2000, estimated: true, inputTokens: 1000, outputTokens: 100 }));
    store.insertRequest(req({ tsEpochMs: NOW - 1000, inputTokens: 0, outputTokens: 0, costUsd: 0, statusCode: 200 }));
    const s = buildSessions(store, '7d', WEEK, { now: NOW }).sessions[0]!;
    assert.deepEqual(s.profile, [1000]);
    assert.equal(s.usageUnknownRequests, 1, 'only the reply that went through with no tokens is unknown');
  } finally { store.close(); }
});

test('a model named "other" is a model, and the rest are a separate figure', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ model: 'other', costUsd: 10, tsEpochMs: NOW - 9000 }));
    for (const m of ['a', 'b', 'c', 'd', 'e']) store.insertRequest(req({ model: m, costUsd: 1, tsEpochMs: NOW - 8000 }));
    const p = buildSessions(store, '7d', WEEK, { now: NOW });
    assert.equal(p.models.length, 5);
    assert.equal(new Set(p.models).size, 5, 'no model is listed twice');
    const b = p.buckets.find((x) => x.costUsd > 0)!;
    const named = b.byModel.reduce((s, m) => s + m.costUsd, 0);
    assert.equal(named + b.otherUsd, 15);
    assert.equal(b.byModel.length, 5);
    assert.equal(new Set(b.byModel.map((m) => m.model)).size, 5);
  } finally { store.close(); }
});

test('an even split adds back to the session cost after the wire rounds it', () => {
  const store = new Store(':memory:');
  try {
    store.insertRequest(req({ sessionId: 'x', costUsd: 1, tsEpochMs: NOW - 5000 }));
    for (const [i, sha] of ['aaaaaaa', 'bbbbbbb', 'ccccccc'].entries()) {
      store.recordObservedCommit({ source: 't', sessionId: 'x', shortSha: sha, branch: 'main', subject: String(i), tsEpochMs: NOW - 4000 + i, cwd: null });
    }
    const wire = JSON.parse(stringifyJson(buildSessions(store, '7d', WEEK, { now: NOW }))) as { outcomes: Record<string, { costUsd: number }> };
    const o = wire.outcomes;
    const sum = ['kept', 'notKept', 'contested', 'unknown', 'maturing', 'unmeasured', 'noCommit'].reduce((s, k) => s + o[k]!.costUsd, 0);
    assert.equal(Math.round(sum * 1e6), 1_000_000);
  } finally { store.close(); }
});

test('the next check date uses each unit\'s own window', () => {
  const { kept } = sampleUnits();
  const aug10 = new Date(2026, 7, 10, 12).getTime();
  const unit = { ...kept, maturing: true, tsEpochMs: aug10, checkWindowDays: 30 } as never;
  const k = keptSummary({ units: [unit], windowDays: 14 });
  assert.equal(k.maturing.nextVerdictMs, aug10 + 30 * DAY);
});

test('ten thousand logged commits are matched in well under a second', () => {
  const store = new Store(':memory:');
  try {
    const { kept } = sampleUnits();
    const n = 10_000;
    const hex = (i: number): string => i.toString(16).padStart(8, '0') + 'f'.repeat(32);
    store.saveRealizationUnits(Array.from({ length: n }, (_, i) => {
      const unit = { ...kept, hash: hex(i) };
      return {
        commitHash: hex(i), project: 'p', tsEpochMs: Number(kept['tsEpochMs']), computedAtMs: NOW, attributedCostUsd: 1,
        maturing: false, realized: false, unitJson: JSON.stringify(unit), costScope: 'window' as const,
      };
    }));
    store.insertRequest(req({ sessionId: 'big', tsEpochMs: NOW - 5000 }));
    for (let i = 0; i < n; i += 1) {
      store.recordObservedCommit({ source: 't', sessionId: 'big', shortSha: hex(i).slice(0, 8), branch: 'main', subject: 's', tsEpochMs: NOW - 4000, cwd: null });
    }
    const t0 = performance.now();
    const s = buildSessions(store, '7d', WEEK, { now: NOW }).sessions[0]!;
    const ms = performance.now() - t0;
    assert.equal(s.commits.length, n);
    assert.ok(s.commits.every((c) => c.outcome === 'kept'));
    assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
  } finally { store.close(); }
});

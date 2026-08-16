import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, requestsToCsv } from '../src/export/csv.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

test('toCsv: quotes cells with commas, quotes, or newlines; doubles internal quotes', () => {
  const csv = toCsv(['a', 'b'], [
    ['plain', 'has,comma'],
    ['has"quote', 'has\nnewline'],
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], 'plain,"has,comma"');
  assert.equal(lines[2], '"has""quote","has\nnewline"');
});

test('requestsToCsv: header + one row, model with a comma stays one field', () => {
  const rows: RequestRow[] = [{
    requestId: 'r1', sessionId: 's1', tsEpochMs: 0, provider: 'anthropic', model: 'claude, opus',
    project: 'p', taskWeight: 1, inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.01, estimated: true, streamed: false, statusCode: 200, durationMs: 5,
    pricing: {
      costBasis: 'fallback_estimate', rateCardSha256: 'a'.repeat(64), rateCardSourceKind: 'bundled',
      rateMatchKind: 'fallback', rateMatchProvider: null, rateMatchModel: null,
    },
  }];
  const csv = requestsToCsv(rows);
  const lines = csv.trim().split('\r\n');
  assert.ok(lines[0]!.startsWith('tsIso,tsEpochMs,provider,model,'));
  assert.ok(lines[1]!.includes('"claude, opus"'), 'comma in model is quoted');
  assert.ok(lines[1]!.includes(',anthropic,'));
  assert.ok(lines[0]!.includes('costBasis,rateCardSha256,rateCardSourceKind,rateMatchKind'));
  assert.ok(lines[1]!.includes('fallback_estimate,' + 'a'.repeat(64) + ',bundled,fallback'));
  assert.ok(lines[1]!.endsWith(',r1'));
});

test('store.requestsInRange: returns rows in the window, oldest first', () => {
  const store = new Store(':memory:');
  const mk = (id: string, ts: number): RequestRow => ({
    requestId: id, sessionId: null, tsEpochMs: ts, provider: 'openai', model: 'gpt', project: 'p',
    taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.5, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  });
  store.insertRequest(mk('late', 2000));
  store.insertRequest(mk('early', 1000));
  store.insertRequest(mk('outside', 9000));
  const got = store.requestsInRange(500, 3000).map((r) => r.requestId);
  assert.deepEqual(got, ['early', 'late']);
  store.close();
});

// ---- Aliased projects must reconcile between the rollup and the export ----

const aliasRow = (id: string, project: string, costUsd: number): RequestRow => ({
  requestId: id, sessionId: null, tsEpochMs: 1000, provider: 'openai', model: 'gpt', project,
  taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
  reasoningTokens: 0, costUsd, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
});

test('export: an aliased row carries both the recorded label and the canonical one', () => {
  const store = new Store(':memory:');
  store.insertRequest(aliasRow('a', 'aegisflow-ts', 1));
  store.setProjectAlias('aegisflow-ts', 'aegisflow');
  const [row] = store.requestsInRange(0, 5000);
  assert.equal(row!.project, 'aegisflow-ts', 'the recorded label is never rewritten');
  assert.equal(row!.projectCanonical, 'aegisflow', 'and the row still reports what it rolls up into');
  const csv = requestsToCsv(store.requestsInRange(0, 5000));
  assert.ok(csv.split('\r\n')[0]!.includes('project,projectCanonical'));
  assert.ok(csv.includes(',aegisflow-ts,aegisflow,'));
  store.close();
});

test('export: the CSV canonical column totals the same as byProject once an alias exists', () => {
  const store = new Store(':memory:');
  store.insertRequest(aliasRow('a', 'aegisflow-ts', 1));
  store.insertRequest(aliasRow('b', 'aegisflow', 2));
  store.insertRequest(aliasRow('c', 'other', 4));
  store.setProjectAlias('aegisflow-ts', 'aegisflow');

  // What the dashboard/CLI report.
  const rollup = new Map(store.byProject(0, 5000).map((b) => [b.label, b.costUsd]));
  // What a BI consumer gets by grouping the export on the canonical column.
  const exported = new Map<string, number>();
  for (const r of store.requestsInRange(0, 5000)) {
    const key = r.projectCanonical ?? r.project;
    exported.set(key, (exported.get(key) ?? 0) + r.costUsd);
  }
  assert.deepEqual([...exported].sort(), [...rollup].sort(), 'export and rollup agree');
  assert.equal(rollup.get('aegisflow'), 3, 'the merged project really did absorb both rows');

  // Grouping on the RAW column is what used to disagree — pinned so the two
  // bases stay visibly different rather than quietly converging.
  const rawGrouped = new Map<string, number>();
  for (const r of store.requestsInRange(0, 5000)) rawGrouped.set(r.project, (rawGrouped.get(r.project) ?? 0) + r.costUsd);
  assert.equal(rawGrouped.get('aegisflow'), 2, 'the raw label still shows only its own rows');
  store.close();
});

test('bySourceWithDepth: an aliased project still credits its source with outcomes', () => {
  const store = new Store(':memory:');
  const row = { ...aliasRow('a', 'aegisflow-ts', 1), source: 'claude-code' };
  store.insertRequest(row);
  store.setProjectAlias('aegisflow-ts', 'aegisflow');
  // A realization snapshot stored under the canonical label.
  store.saveRealizationUnits([
    { commitHash: 'h1', project: 'aegisflow', tsEpochMs: 1000, computedAtMs: 1000, attributedCostUsd: 1, maturing: false, realized: true, unitJson: '{}', costScope: 'project' },
  ]);
  const src = store.bySourceWithDepth(0, 5000).find((s) => s.label === 'claude-code');
  assert.ok(src, 'the source is present');
  assert.equal(src!.hasOutcomes, true, 'the alias must not hide realized outcomes from its source');
  store.close();
});

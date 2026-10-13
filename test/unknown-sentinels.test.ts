import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store/db.ts';
import { cmdAlloc } from '../src/cli/allocCmd.ts';
import { cmdBilling } from '../src/cli/billingCmd.ts';
import { buildClaimLayers, type ClaimInputs } from '../src/dashboard/web/app/core/claimLayers.ts';
import { meteredClaimSupport } from '../src/dashboard/claim-support.ts';
import { parseOpencodeMessage, importOpencode } from '../src/connect/opencode.ts';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-sentinels-'));
const NOTHING: ClaimInputs = { overview: null, billing: null, allocation: null, value: null };
const NOW = Date.UTC(2026, 8, 1);

test('claim freshness treats null and zero run instants as unknown', () => {
  for (const computedAtMs of [null, 0, Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
    const input = {
      ...NOTHING,
      billing: { summary: { recordCount: 1 }, reconciliation: { runs: [{ reconciliationRunId: 'r', computedAtMs, result: {} }] } },
      allocation: { costCentres: [], rules: [], runs: [{ computedAtMs }], reconciliation: { everRun: true, latestComputedAtMs: computedAtMs }, excludedFrom: [] },
    } as unknown as ClaimInputs;
    const layers = buildClaimLayers(input, '30d');
    assert.equal(layers[1]!.inspection.freshness, 'not established');
    assert.equal(layers[2]!.inspection.freshness, 'not established');
    assert.ok(layers[2]!.inspection.assumptions.some((s) => s.includes('not established')));
  }
});

test('metered retention note names an unknown boundary without inventing 1970', () => {
  for (const prunedBeforeMs of [null, 0]) {
    const claim = meteredClaimSupport({ totalCostUsd: 1, estimatedCostUsd: 0, retention: { truncated: true, prunedBeforeMs, rowsRemoved: 2 } });
    assert.match(claim.note!, /unknown/);
    assert.doesNotMatch(claim.note!, /1970/);
    assert.equal(claim.profile.coverage, 'partial', 'the missing boundary must not hide known truncation');
  }
});

test('allocation CLI displays unknown retention boundaries in both disclosure lines', (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  for (const prunedBeforeMs of [null, 0]) {
    output.length = 0;
    const allocation = new Store(':memory:');
    const fixture = allocation.allocatePeriod(NOW - 86400000, NOW);
    allocation.close();
    fixture.retention = { truncated: true, prunedBeforeMs };
    t.mock.method(Store.prototype, 'allocatePeriod', () => fixture);
    cmdAlloc({ _: ['run'], from: '2026-08-31', to: '2026-09-01' });
    const text = output.join('\n');
    assert.match(text, /before unknown/);
    assert.doesNotMatch(text, /1970/);
    assert.equal((text.match(/unknown/g) ?? []).length, 2, 'both the empty-centre and total disclosure must remain honest');
  }
});

test('billing coverage CLI displays unknown for null and zero retention instants', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  for (const prunedBeforeMs of [null, 0]) {
    output.length = 0;
    const excluded = { requestCount: 0, costUsd: 0 };
    const fixture = {
      observation: { observationRunId: 'r', periodStartMs: NOW - 86400000, periodEndMs: NOW, providerLineCount: 0, currencies: [] },
      capturedOnDeclaredRoute: { requestCount: 0, costUsd: 0, estimatedRequestCount: 0 },
      excludedFromDeclaredRoute: { importedOrNative: excluded, unscopedOrLegacyOpenAiProxy: excluded, differentDeclaredOpenAiScope: excluded, otherProvider: excluded },
      localLedgerRetention: { truncated: true, prunedBeforeMs }, blockers: [],
    } as unknown as NonNullable<ReturnType<Store['openAiCostsCaptureCoverage']>>;
    t.mock.method(Store.prototype, 'openAiCostsCaptureCoverage', () => fixture);
    await cmdBilling({ _: ['openai-costs', 'coverage'] });
    assert.match(output.join('\n'), /before unknown/);
    assert.doesNotMatch(output.join('\n'), /1970/);
  }
});

test('billing readiness CLI does not date a zero retention sentinel to 1970', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  const store = new Store(':memory:');
  const floor = store.retentionFloor();
  store.close();
  t.mock.method(Store.prototype, 'retentionFloor', () => ({ ...floor, requestsPrunedBeforeMs: 0 }));
  const previousExitCode = process.exitCode;
  try { await cmdBilling({ _: ['reconcile'] }); } finally { process.exitCode = previousExitCode; }
  assert.match(output.join('\n'), /before unknown/);
  assert.doesNotMatch(output.join('\n'), /1970/);
});

test('an unavailable realized payload is not described as zero matured outcomes', () => {
  const realized = buildClaimLayers(NOTHING, '30d')[3]!;
  assert.match(realized.basis, /could not read|unavailable/i);
  assert.doesNotMatch(realized.basis, /no work units/);
  assert.match(realized.nextStep!, /running|retry|read/i);
  assert.deepEqual(realized.inspection.missingEvidence, ['a readable outcome report']);
});

test('unavailable billing and allocation reports are not described as empty reports', () => {
  const layers = buildClaimLayers(NOTHING, '30d');
  assert.match(layers[1]!.basis, /could not read|unavailable/i);
  assert.doesNotMatch(layers[1]!.basis, /no provider bill/);
  assert.match(layers[2]!.basis, /could not read|unavailable/i);
  assert.doesNotMatch(layers[2]!.basis, /no cost centres/);
  for (const layer of [layers[1]!, layers[2]!]) assert.match(layer.nextStep!, /running|retry|read/i);
});

function message(overrides: Record<string, unknown> = {}) {
  return { role: 'assistant', modelID: 'free-model', providerID: 'opencode', cost: 0, tokens: { input: 1, output: 1 }, ...overrides };
}

test('OpenCode refuses a missing or zero timestamp instead of recording 1970', () => {
  for (const fallback of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
    assert.equal(parseOpencodeMessage('m', JSON.stringify(message()), fallback), null);
  }
  assert.equal(parseOpencodeMessage('m', JSON.stringify(message({ time: { created: 0 } })), NOW), null, 'an explicit unknown time is never backfilled');
  assert.equal(parseOpencodeMessage('m', JSON.stringify(message()), NOW)!.tsEpochMs, NOW, 'the recorded database time remains usable when JSON omits it');
});

test('OpenCode refuses absent or invalid cost while preserving explicitly reported zero', () => {
  for (const cost of [undefined, null, -1, '0', Number.POSITIVE_INFINITY]) {
    assert.equal(parseOpencodeMessage('m', JSON.stringify(message({ cost, time: { created: NOW } }))), null);
  }
  assert.equal(parseOpencodeMessage('m', JSON.stringify(message({ time: { created: NOW } })))!.reportedCostUsd, 0);
});

test('OpenCode database rows with zero time or absent cost cannot reach user ledger totals', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'segreant-opencode-sentinels-')), 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  insert.run('undated', 's', 0, JSON.stringify(message()));
  insert.run('unpriced', 's', NOW, JSON.stringify(message({ cost: null })));
  insert.run('free', 's', NOW, JSON.stringify(message()));
  db.close();
  const store = new Store(':memory:');
  try {
    const summary = importOpencode(store, { root: file });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.earliestMs, NOW);
    assert.equal(store.summary(0, NOW + 1).requests, 1);
    assert.equal(store.summary(0, NOW + 1).costUsd, 0, 'one measured free request is a real zero');
  } finally { store.close(); }
});

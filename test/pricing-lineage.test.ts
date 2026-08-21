import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Do not inherit a developer's live price-card cache while asserting local lineage.
process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-pricing-lineage-home-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { computeCost, legacyPricingEvidence, toolReportedPricingEvidence, unpricedPricingEvidence } from '../src/cost/pricing.ts';

function row(id: string, pricing?: RequestRow['pricing']): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs: 1_000, provider: 'anthropic', model: 'claude-opus-4-8',
    project: 'p', taskWeight: 1, inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 0.01, estimated: false, streamed: true, statusCode: 200, durationMs: 5,
    pricing,
  };
}

test('new locally priced rows round-trip their card and match evidence through recent/export projections', () => {
  const store = new Store(':memory:');
  const cost = computeCost('anthropic', 'claude-opus-4-8', {
    inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0,
  });
  store.insertRequest({ ...row('local', cost.pricing), costUsd: cost.costUsd, estimated: cost.estimated });
  const read = store.recent(1)[0]!;
  assert.deepEqual(read.pricing, cost.pricing);
  assert.deepEqual(store.requestsInRange(0, 2_000)[0]!.pricing, cost.pricing);
  store.close();
});

test('missing lineage stays permanently marked legacy rather than inferred from the current card', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('old'));
  assert.deepEqual(store.recent(1)[0]!.pricing, legacyPricingEvidence());
  store.close();
});

test('a pre-lineage on-disk ledger migrates without rewriting its historical price meaning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-legacy-ledger-'));
  const path = join(dir, 'fiscus.db');
  const old = new DatabaseSync(path);
  old.prepare(`CREATE TABLE requests (
    request_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, ts_iso TEXT NOT NULL, ts_epoch_ms INTEGER NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'default', task_weight REAL NOT NULL DEFAULT 1,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0, streamed INTEGER NOT NULL DEFAULT 0, status_code INTEGER, duration_ms INTEGER
  )`).run();
  old.prepare(`INSERT INTO requests VALUES ('before-lineage', NULL, '1970-01-01T00:00:01.000Z', 1000,
    'anthropic', 'claude-opus-4-8', 'p', 1, 1, 1, 0, 0, 0, 0.01, 0, 1, 200, 1)`).run();
  old.close();

  const store = new Store(path);
  const migrated = store.recent(1)[0]!;
  assert.equal(migrated.costUsd, 0.01);
  assert.deepEqual(migrated.pricing, legacyPricingEvidence());
  store.close();
});

test('tool-reported and unpriced events cannot be misread as local rate-card prices', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('reported', toolReportedPricingEvidence()));
  store.insertRequest(row('unpriced', unpricedPricingEvidence()));
  const byId = new Map(store.requestsInRange(0, 2_000).map((r) => [r.requestId, r]));
  assert.equal(byId.get('reported')!.pricing!.costBasis, 'tool_reported_unverified');
  assert.equal(byId.get('reported')!.pricing!.rateCardSha256, null);
  assert.equal(byId.get('unpriced')!.pricing!.costBasis, 'unpriced');
  assert.equal(byId.get('unpriced')!.pricing!.rateMatchKind, 'unpriced');
  store.close();
});

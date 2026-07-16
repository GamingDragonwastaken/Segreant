import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any real ~/.aegisflow pricing override (incident #3 in the log).
process.env.AEGIS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { computeCost, type Provider } from '../src/cost/pricing.ts';

function req(over: Partial<RequestRow>): RequestRow {
  return {
    requestId: Math.random().toString(36).slice(2), sessionId: null, tsEpochMs: 1000, provider: 'anthropic',
    model: 'm', project: 'p', taskWeight: 1, inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1, estimated: false, streamed: false, statusCode: 200,
    durationMs: 1, ...over,
  };
}

test('reprice: only estimated rows are candidates; exact-priced rows never touched', () => {
  const store = new Store(':memory:');
  store.insertRequest(req({ requestId: 'exact', model: 'claude-opus-4-8', estimated: false, costUsd: 5 }));
  store.insertRequest(req({ requestId: 'est', model: 'claude-opus-4-8', estimated: true, costUsd: 99 }));
  const rows = store.estimatedRequestRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.requestId, 'est');
  store.close();
});

test('reprice: a row whose model the card now resolves EXACTLY is re-costed and un-flagged; a still-fuzzy model is left alone', () => {
  const store = new Store(':memory:');
  // Metered when the card lacked the model → priced at the unknown fallback, flagged.
  store.insertRequest(req({ requestId: 'nowExact', model: 'claude-opus-4-8', estimated: true, costUsd: 3 }));
  // A dated id that only family-matches → still an estimate under the current card.
  store.insertRequest(req({ requestId: 'stillFuzzy', model: 'claude-sonnet-4-6-20990101', estimated: true, costUsd: 7 }));

  const updates: Array<{ requestId: string; costUsd: number }> = [];
  for (const r of store.estimatedRequestRows()) {
    const c = computeCost(r.provider as Provider, r.model, {
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
    });
    if (!c.estimated) updates.push({ requestId: r.requestId, costUsd: c.costUsd });
  }
  assert.deepEqual(updates.map((u) => u.requestId), ['nowExact']); // fuzzy row excluded

  store.applyRepricedCosts(updates);
  const after = store.estimatedRequestRows();
  assert.deepEqual(after.map((r) => r.requestId), ['stillFuzzy']); // flag cleared on the repriced row only

  // The re-cost is the real exact price (1M input tokens at the card's opus rate), not the old guess.
  const expected = computeCost('anthropic', 'claude-opus-4-8', {
    inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  }).costUsd;
  const total = store.summary(0, 5000).costUsd;
  assert.ok(Math.abs(total - (expected + 7)) < 1e-9, `summary ${total} should be exact ${expected} + untouched 7`);
  store.close();
});

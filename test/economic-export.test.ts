import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { money } from '../src/economics/money.ts';
import { legacyPricingEvidence } from '../src/cost/pricing.ts';
import { economicRequestsToCsv, economicRequestsToJson } from '../src/export/economic.ts';

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: 'request:economic-export', sessionId: null, tsEpochMs: 0,
    provider: 'anthropic', model: 'claude-opus-4-8', project: 'fiscus', taskWeight: 1,
    inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 1, economicAmount: money('1', 'USD', 'list'), estimated: true,
    streamed: false, statusCode: 200, durationMs: 1, via: 'proxy',
    ...overrides,
  };
}

test('economic export carries exact original/effective Money and correction lineage', () => {
  const store = new Store(':memory:');
  try {
    const exact = request();
    const legacy = request({ requestId: 'request:economic-export-legacy', economicAmount: undefined, costUsd: 2, estimated: false });
    store.insertRequest(exact);
    store.insertRequest(legacy);
    const source = store.economic().read('economic:request:request:economic-export:charge')!;
    store.applyRepricedCosts([{
      requestId: exact.requestId,
      costUsd: 1.25,
      pricing: legacyPricingEvidence(),
      economicAmount: money('1.25', 'USD', 'list'),
    }], Date.parse(source.recordedAt) + 1);
    const rows = store.economicRequestsInRange(0, 1);
    assert.equal(rows.length, 2);
    const corrected = rows.find((row) => row.requestId === exact.requestId)!;
    assert.equal(corrected.coverage, 'exact');
    assert.equal(corrected.sourceAmount, '1');
    assert.equal(corrected.sourceBasis, 'list');
    assert.equal(corrected.effectiveAmount, '1.25');
    assert.equal(corrected.effectiveBasis, 'effective');
    assert.deepEqual(corrected.sourceEventIds, [source.id, `economic:request:${exact.requestId}:price-corrected`].sort());
    const unresolved = rows.find((row) => row.requestId === legacy.requestId)!;
    assert.equal(unresolved.coverage, 'legacy_unknown');
    assert.equal(unresolved.effectiveAmount, null);
    assert.equal(unresolved.compatibilityCostUsd, 2);
    const json = economicRequestsToJson(rows);
    assert.match(json, /"effectiveAmount":"1\.25"/);
    assert.match(json, /"coverage":"legacy_unknown"/);
    assert.equal(json.includes('BigInt'), false);
    const csv = economicRequestsToCsv(rows);
    assert.match(csv.split('\r\n')[0]!, /sourceAmount.*effectiveAmount.*sourceEventIds/);
    assert.match(csv, /1\.25/);
    assert.match(csv, /legacy_unknown/);
  } finally {
    store.close();
  }
});

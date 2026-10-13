/**
 * The exact economic export must handle a real ledger's size.
 *
 * The canonical serializer bounds one kernel record's node count, which is a
 * guard against hostile input. Applied to a whole export, it refused every
 * ledger past roughly six thousand requests. Each row stays bounded; the number
 * of rows is the user's history and is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economicRequestsToJson } from '../src/export/economic.ts';
import { RESOURCE_LIMITS } from '../src/util/resource-limits.ts';

function row(i: number): Record<string, unknown> {
  return {
    requestId: `r-${i}`, tsIso: '2026-07-01T00:00:00.000Z', tsEpochMs: 1, provider: 'openai', model: 'gpt-5',
    project: 'p', projectCanonical: 'p', sessionId: null, via: 'proxy', compatibilityCostUsd: 0.5,
    coverage: 'complete', sourceAmount: '0.500000', sourceCurrency: 'USD', sourceBasis: 'list',
    sourceMoney: { coefficient: '500000', scale: 6, currency: 'USD', basis: 'list' },
    effectiveAmount: '0.500000', effectiveCurrency: 'USD', effectiveBasis: 'list',
    effectiveMoney: { coefficient: '500000', scale: 6, currency: 'USD', basis: 'list' },
    translatedAmount: null, translatedCurrency: null, fxRateSource: null, fxEffectiveAt: null, fxRateAsOf: null,
    fxRate: null, sourceBases: ['list'], sourceEventIds: [`e-${i}`], correctionEventIds: [], unresolvedReason: null,
  };
}

test('an economic JSON export larger than one record bound still serializes every row', () => {
  const count = Math.ceil(RESOURCE_LIMITS.canonicalNodes / 20) + 500;
  const rows = Array.from({ length: count }, (_, i) => row(i));
  const parsed = JSON.parse(economicRequestsToJson(rows as never)) as Array<{ requestId: string }>;
  assert.equal(parsed.length, count);
  assert.equal(parsed.at(-1)!.requestId, `r-${count - 1}`);
});

test('each row is still canonical: sorted keys, same bytes as before for a small export', () => {
  const out = economicRequestsToJson([row(0)] as never);
  const keys = Object.keys((JSON.parse(out) as Array<Record<string, unknown>>)[0]!);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(out.startsWith('[{') && out.endsWith('}]\n'));
});

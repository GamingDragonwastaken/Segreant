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

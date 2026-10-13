/**
 * Request-ledger CSV must not carry live spreadsheet formulas.
 *
 * Project, model, user and source labels come from tool logs and directory
 * names, so anyone who can name a folder can put `=HYPERLINK(...)` into a CSV
 * that finance opens in a spreadsheet. Text that starts a formula is prefixed
 * with an apostrophe; numbers, including negative amounts written as strings,
 * stay numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, requestsToCsv } from '../src/export/csv.ts';
import type { RequestRow } from '../src/store/db.ts';

test('formula starters in text cells are neutralised', () => {
  for (const text of ['=HYPERLINK("http://example.invalid","x")', '+cmd', '-2+3', '@SUM(A1)', '\tTAB', '\rCR']) {
    const out = toCsv(['v'], [[text]]).split('\r\n')[1]!;
    assert.ok(out.replace(/^"/, '').startsWith("'"), `${JSON.stringify(text)} must not start a formula: ${out}`);
  }
});

test('numbers stay numbers, including negative amounts written as strings', () => {
  const out = toCsv(['a', 'b', 'c', 'd', 'e'], [[-1.5, '-0.500000', '+2', '1e-6', 'plain-label']]).split('\r\n')[1];
  assert.equal(out, '-1.5,-0.500000,+2,1e-6,plain-label');
});

test('a hostile project label in the request ledger cannot evaluate', () => {
  const row = {
    requestId: 'r1', sessionId: null, tsEpochMs: Date.UTC(2026, 9, 1), provider: 'openai', model: '=1+1',
    project: '=HYPERLINK("http://example.invalid","open")', taskWeight: 1, inputTokens: 1, outputTokens: 1,
    cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0.25, estimated: false,
    streamed: false, statusCode: 200, durationMs: 1, user: '@me', source: 'proxy',
  } as unknown as RequestRow;
  const line = requestsToCsv([row]).split('\r\n')[1]!;
  assert.doesNotMatch(line, /(^|,)"?[=+@]/, `no cell may begin with a formula starter: ${line}`);
  assert.match(line, /,0\.25,/, 'cost stays a number');
});

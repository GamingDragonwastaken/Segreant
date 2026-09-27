/**
 * Resuming a Claude Code session copies its earlier requests into the new
 * transcript under the new session id. The importer must record each provider
 * request once, across files and across runs, and a genuine disagreement about
 * one request must be counted and disclosed rather than abort the import.
 * (Found on a real ledger: 2,869 of 19,600 request ids appeared in two files,
 * and `scan --setup` stopped after 20 rows.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store, RequestObservationConflictError } from '../src/store/db.ts';
import { importClaudeCode } from '../src/connect/claudeCode.ts';
import { money } from '../src/economics/money.ts';

function line(requestId: string, sessionId: string, outputTokens = 500): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${sessionId}-${requestId}`,
    requestId,
    timestamp: '2026-07-01T10:00:00.000Z',
    sessionId,
    cwd: 'C:\\Users\\dev\\projects\\my-app',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: outputTokens } },
  });
}

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'cc-resume-db-')), 'test.db'));
}

test('a request copied into a resumed session transcript is recorded once, in one run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-resume-'));
  mkdirSync(join(root, 'proj'));
  writeFileSync(join(root, 'proj', 'original.jsonl'), [line('req_1', 'sess-a'), line('req_2', 'sess-a')].join('\n'));
  writeFileSync(join(root, 'proj', 'resumed.jsonl'), [line('req_1', 'sess-b'), line('req_2', 'sess-b'), line('req_3', 'sess-b')].join('\n'));

  const store = freshStore();
  const sum = await importClaudeCode(store, { root });
  assert.equal(sum.inserted, 3, 'req_1, req_2 once each, plus the new req_3');
  assert.equal(sum.conflictingObservations ?? 0, 0);
  assert.equal(store.summary(0, Date.now()).requests, 3);
  store.close();
});

test('a copy met in a later run is a duplicate, not a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-resume-later-'));
  mkdirSync(join(root, 'proj'));
  writeFileSync(join(root, 'proj', 'original.jsonl'), line('req_1', 'sess-a'));
  const store = freshStore();
  assert.equal((await importClaudeCode(store, { root })).inserted, 1);

  // The session is resumed after the first import: the copy arrives in a new file.
  writeFileSync(join(root, 'proj', 'resumed.jsonl'), [line('req_1', 'sess-b'), line('req_9', 'sess-b')].join('\n'));
  const second = await importClaudeCode(store, { root });
  assert.equal(second.inserted, 1, 'only req_9 is new');
  assert.equal(second.conflictingObservations ?? 0, 0);
  assert.equal(store.summary(0, Date.now()).requests, 2);
  store.close();
});

test('two logs that disagree about one request are counted and the first record stands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-resume-conflict-'));
  mkdirSync(join(root, 'proj'));
  writeFileSync(join(root, 'proj', 'original.jsonl'), line('req_1', 'sess-a', 500));
  const store = freshStore();
  const first = await importClaudeCode(store, { root });
  const recorded = first.costUsd;

  writeFileSync(join(root, 'proj', 'other.jsonl'), line('req_1', 'sess-b', 900));
  const second = await importClaudeCode(store, { root });
  assert.equal(second.inserted, 0);
  assert.equal(second.conflictingObservations, 1, 'the disagreement is disclosed, not swallowed');
  assert.ok(Math.abs(store.summary(0, Date.now()).costUsd - recorded) < 1e-9, 'the first record is unchanged');
  store.close();
});

test('the live proxy path still refuses a conflicting replay outright', () => {
  const store = freshStore();
  const base = {
    requestId: 'req_proxy', sessionId: null, tsEpochMs: Date.parse('2026-07-01T10:00:00Z'), provider: 'anthropic',
    model: 'claude-opus-4-8', project: 'p', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0.01, estimated: false, streamed: false, statusCode: 200,
    durationMs: 1, user: null, source: 'proxy', cwd: null,
  };
  const amount = (value: string) => money(value, 'USD', 'list');
  store.insertRequest({ ...base, economicAmount: amount('0.01') } as never);
  assert.throws(
    () => store.insertRequestIfNew({ ...base, economicAmount: amount('0.02') } as never),
    (err: unknown) => err instanceof Error && !(err instanceof RequestObservationConflictError),
  );
  store.close();
});

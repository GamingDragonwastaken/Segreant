/**
 * The importers record what a request finally used.
 *
 * Claude Code writes several transcript lines per request while it streams, and
 * the early ones can carry unfinished token counts. Codex compresses a finished
 * rollout in place. Reading the first line, or only the uncompressed files, lost
 * 8% of one real ledger's Claude output tokens and 95% of its Codex usage while
 * every total still looked complete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { importClaudeCode } from '../src/connect/claudeCode.ts';
import { importCodex } from '../src/connect/codex.ts';
import { readLogLines } from '../src/connect/logFiles.ts';
import { RESOURCE_LIMITS } from '../src/util/resource-limits.ts';

interface Usage { input: number; output: number; write?: number; read?: number }
function claudeLine(requestId: string, u: Usage, at = '2026-07-01T10:00:00.000Z', sessionId = 'sess-a'): string {
  return JSON.stringify({
    type: 'assistant', uuid: `${requestId}-${u.output}`, requestId, timestamp: at, sessionId, cwd: '/work/app',
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.write ?? 0, cache_read_input_tokens: u.read ?? 0 },
    },
  });
}
function claudeRoot(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-finished-'));
  mkdirSync(join(root, 'proj'));
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(root, 'proj', name), lines.join('\n'));
  return root;
}
const freshStore = (): Store => new Store(join(mkdtempSync(join(tmpdir(), 'cc-finished-db-')), 'test.db'));
const tokens = (store: Store): number[] => {
  const s = store.summary(0, Date.now());
  return [s.requests, s.inputTokens, s.outputTokens];
};

test('a request keeps its finished usage, at the time its first line was written', async () => {
  const root = claudeRoot({
    'a.jsonl': [
      claudeLine('req_1', { input: 0, output: 0, write: 2796 }),
      claudeLine('req_1', { input: 2, output: 2377, write: 2796, read: 613_018 }, '2026-07-01T10:00:09.000Z'),
      claudeLine('req_2', { input: 5, output: 7 }, '2026-07-01T10:01:00.000Z'),
      claudeLine('req_1', { input: 2, output: 2377, write: 2796, read: 613_018 }, '2026-07-01T10:00:10.000Z'),
    ],
  });
  const store = freshStore();
  const sum = await importClaudeCode(store, { root });
  assert.equal(sum.inserted, 2);
  assert.deepEqual(tokens(store), [2, 7, 2384]);
  const first = store.recent(10).find((r) => r.requestId === 'req_1')!;
  assert.equal(first.tsEpochMs, Date.parse('2026-07-01T10:00:00.000Z'));
  assert.equal(first.cacheReadTokens, 613_018);
  store.close();
});

test('a request recorded while it was still streaming is completed by the next import, and the change is kept', async () => {
  const unfinished = claudeLine('req_1', { input: 2, output: 8 });
  const root = claudeRoot({ 'a.jsonl': [unfinished] });
  const store = freshStore();
  await importClaudeCode(store, { root });
  const before = store.summary(0, Date.now());

  writeFileSync(join(root, 'proj', 'a.jsonl'), [unfinished, claudeLine('req_1', { input: 2, output: 800 })].join('\n'));
  const second = await importClaudeCode(store, { root });
  assert.equal(second.inserted, 0);
  assert.equal(second.completedObservations, 1);
  assert.equal(second.conflictingObservations ?? 0, 0);
  assert.deepEqual(tokens(store), [1, 2, 800]);

  // The exact ledger and the request row agree on the new cost, and the old one is still on record.
  const after = store.summary(0, Date.now());
  assert.ok(after.costUsd > before.costUsd * 10);
  const exact = store.exactSpendBetween(0, Date.now());
  assert.equal(exact.unresolvedRequests, 0);
  const events = store.requestPriceEvents('req_1');
  assert.deepEqual(events.map((e) => e.action), ['usage_corrected']);
  assert.ok(Math.abs(events[0]!.previousCostUsd - before.costUsd) < 1e-12);

  // And again: a third, longer line chains from the last correction rather than from the original.
  writeFileSync(join(root, 'proj', 'a.jsonl'), [unfinished, claudeLine('req_1', { input: 2, output: 800 }), claudeLine('req_1', { input: 2, output: 900 })].join('\n'));
  assert.equal((await importClaudeCode(store, { root })).completedObservations, 1);
  assert.deepEqual(tokens(store), [1, 2, 900]);
  assert.equal(store.exactSpendBetween(0, Date.now()).unresolvedRequests, 0);
  store.close();
});

test('an older, shorter copy of a finished request is a duplicate, not a conflict', async () => {
  const root = claudeRoot({
    'a.jsonl': [claudeLine('req_1', { input: 2, output: 800 })],
    'b.jsonl': [claudeLine('req_1', { input: 2, output: 8 }, undefined, 'sess-b')],
  });
  const store = freshStore();
  const sum = await importClaudeCode(store, { root });
  assert.equal(sum.inserted, 1);
  assert.equal(sum.conflictingObservations ?? 0, 0);
  assert.deepEqual(tokens(store), [1, 2, 800]);
  store.close();
});

test('a price change between two imports of one request is not a disagreement about it', async () => {
  const root = claudeRoot({ 'a.jsonl': [claudeLine('req_1', { input: 2, output: 800 })] });
  const store = freshStore();
  await importClaudeCode(store, { root });
  store.raw().prepare('UPDATE requests SET cost_usd = cost_usd').run();
  const again = await importClaudeCode(store, { root, rescan: true });
  assert.deepEqual([again.inserted, again.conflictingObservations ?? 0, again.completedObservations ?? 0], [0, 0, 0]);
  store.close();
});

function rolloutLines(sessionId: string): string[] {
  const count = (ts: string, input: number, cached: number, output: number) => JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } },
  });
  return [
    JSON.stringify({ timestamp: '2026-07-01T10:00:00Z', type: 'session_meta', payload: { id: sessionId, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5' } }),
    count('2026-07-01T10:01:00Z', 1000, 100, 200),
    count('2026-07-01T10:02:00Z', 1800, 300, 350),
  ];
}
function codexRoot(): { root: string; day: string } {
  const root = mkdtempSync(join(tmpdir(), 'codex-zst-'));
  const day = join(root, 'sessions', '2026', '07', '01');
  mkdirSync(day, { recursive: true });
  return { root, day };
}

test('Codex rollouts compressed with zstd or gzip are read like plain ones', async () => {
  const { root, day } = codexRoot();
  writeFileSync(join(day, 'rollout-a.jsonl.zst'), zstdCompressSync(Buffer.from(rolloutLines('sess-a').join('\n'))));
  writeFileSync(join(day, 'rollout-b.jsonl.gz'), gzipSync(Buffer.from(rolloutLines('sess-b').join('\r\n'))));
  writeFileSync(join(day, 'rollout-c.jsonl'), rolloutLines('sess-c').join('\n'));
  const store = freshStore();
  const sum = await importCodex(store, { root });
  assert.equal(sum.files, 3);
  assert.equal(sum.inserted, 6);
  assert.deepEqual(tokens(store), [6, 3 * 1500, 3 * 350]);
  assert.equal(sum.unreadFiles ?? 0, 0);
  store.close();
});

test('compressing a rollout that was already imported adds nothing', async () => {
  const { root, day } = codexRoot();
  const plain = join(day, 'rollout-a.jsonl');
  writeFileSync(plain, rolloutLines('sess-a').join('\n'));
  const store = freshStore();
  assert.equal((await importCodex(store, { root })).inserted, 2);
  writeFileSync(`${plain}.zst`, zstdCompressSync(readFileSync(plain)));
  rmSync(plain);
  const again = await importCodex(store, { root });
  assert.deepEqual([again.inserted, again.conflictingObservations ?? 0], [0, 0]);
  store.close();
});

test('a damaged or unknown-format log is reported as missing usage, and retried', async () => {
  const { root, day } = codexRoot();
  const whole = zstdCompressSync(Buffer.from(rolloutLines('sess-a').join('\n')));
  writeFileSync(join(day, 'rollout-a.jsonl.zst'), whole.subarray(0, whole.length - 6));
  writeFileSync(join(day, 'rollout-b.jsonl.br'), 'x');
  const store = freshStore();
  const sum = await importCodex(store, { root });
  assert.equal(sum.unreadFiles, 2);
  assert.equal(sum.captureCoverage, 'truncated');
  writeFileSync(join(day, 'rollout-a.jsonl.zst'), whole);
  const again = await importCodex(store, { root });
  assert.equal(again.unreadFiles, 1);
  assert.equal(store.summary(0, Date.now()).requests, 2);
  store.close();
});

test('log lines survive chunk boundaries, carriage returns, a byte-order mark and an oversized neighbour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-lines-'));
  const big = 'x'.repeat(RESOURCE_LIMITS.transcriptLineBytes + 1);
  const long = 'é'.repeat(300_000);
  const file = join(dir, 'a.jsonl');
  writeFileSync(file, `﻿one\r\n${big}\n${long}\n\nlast`);
  let dropped = 0;
  const seen: string[] = [];
  for await (const line of readLogLines(file, () => { dropped += 1; })) seen.push(line);
  assert.deepEqual(seen, ['one', long, '', 'last']);
  assert.equal(dropped, 1);
});

test('a large line that could not hold usage does not mark the import incomplete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-large-user-'));
  mkdirSync(join(root, 'proj'));
  writeFileSync(join(root, 'proj', 'a.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'cc-large-user-db-')), 'db.sqlite'));
  try {
    const sum = await importClaudeCode(store, { root });
    assert.deepEqual([sum.truncatedLines ?? 0, sum.captureCoverage ?? 'complete'], [0, 'complete']);
  } finally {
    store.close();
  }
});

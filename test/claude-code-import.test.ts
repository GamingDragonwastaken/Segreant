/**
 * Native Claude Code metering: the transcript parser must keep exactly the
 * billable traffic (dedupe by requestId, skip synthetic entries) and the
 * importer must be idempotent — re-running adds nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { parseTranscriptLine, importClaudeCode } from '../src/connect/claudeCode.ts';
import { computeCost } from '../src/cost/pricing.ts';

function assistantLine(over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-1',
    requestId: 'req_A',
    timestamp: '2026-07-01T10:00:00.000Z',
    sessionId: 'sess-1',
    cwd: 'C:\\Users\\dev\\projects\\my-app',
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
        ...usage,
      },
    },
    ...over,
  });
}

test('parse: extracts exact usage, project from cwd basename, and the dominant cache TTL', () => {
  const ev = parseTranscriptLine(assistantLine());
  assert.ok(ev);
  assert.equal(ev.requestId, 'req_A');
  assert.equal(ev.model, 'claude-opus-4-8');
  assert.equal(ev.project, 'my-app');
  assert.equal(ev.inputTokens, 1000);
  assert.equal(ev.cacheWriteTokens, 2000);
  assert.equal(ev.cacheWriteTtl, '1h', 'the 1h bucket dominates → priced at the 1h write rate');
});

test('parse: everything that is not billable traffic is null — never a throw', () => {
  assert.equal(parseTranscriptLine('{torn json'), null);
  assert.equal(parseTranscriptLine(JSON.stringify({ type: 'user', message: {} })), null);
  assert.equal(parseTranscriptLine(assistantLine({ message: { model: '<synthetic>', usage: { input_tokens: 1 } } })), null);
  assert.equal(parseTranscriptLine(assistantLine({ timestamp: 'not-a-date' })), null);
});

test('import: one API request streamed as many lines lands ONCE, and re-import adds nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-transcripts-'));
  mkdirSync(join(root, 'proj-a'));
  // The realistic shape: the same requestId appears twice with identical usage
  // (one streamed response, several transcript entries), plus noise lines.
  writeFileSync(
    join(root, 'proj-a', 'session1.jsonl'),
    [
      assistantLine(),
      assistantLine({ uuid: 'uuid-2' }), // same requestId — must not double-count
      JSON.stringify({ type: 'user', text: 'hi' }),
      assistantLine({ uuid: 'uuid-3', requestId: 'req_B', timestamp: '2026-07-01T11:00:00.000Z' }),
      '{torn tail of a live session',
    ].join('\n'),
    'utf8',
  );

  const db = join(mkdtempSync(join(tmpdir(), 'cc-db-')), 'test.db');
  const store = new Store(db);
  const first = await importClaudeCode(store, { root });
  assert.equal(first.eventsSeen, 2, 'req_A (deduped) + req_B');
  assert.equal(first.inserted, 2);
  // Priced through the SAME cost engine as the proxy — including the 1h cache-write rate.
  const expected = computeCost('anthropic', 'claude-opus-4-8', {
    inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 3000, cacheWriteTtl: '1h',
  });
  assert.ok(Math.abs(first.costUsd - 2 * expected.costUsd) < 1e-9);

  const again = await importClaudeCode(store, { root });
  assert.equal(again.inserted, 0, 'idempotent — the natural key blocks every duplicate');

  // The rows are real store rows: visible to summary, tagged with the source.
  const sum = store.summary(0, Date.now());
  assert.equal(sum.requests, 2);
  const bySource = store.bySource(0, Date.now());
  assert.equal(bySource[0]!.label, 'claude-code');
  store.close();
});

test('import: missing transcripts directory is an honest empty result, not a crash', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'cc-db2-')), 'test.db');
  const store = new Store(db);
  const sum = await importClaudeCode(store, { root: join(tmpdir(), 'definitely-not-a-real-dir-xyz') });
  assert.deepEqual([sum.files, sum.eventsSeen, sum.inserted], [0, 0, 0]);
  store.close();
});

test('import: --days cutoff drops older traffic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-transcripts2-'));
  writeFileSync(
    join(root, 'old.jsonl'),
    [
      assistantLine({ requestId: 'req_old', timestamp: '2020-01-01T00:00:00.000Z' }),
      assistantLine({ uuid: 'uuid-9', requestId: 'req_new', timestamp: new Date().toISOString() }),
    ].join('\n'),
    'utf8',
  );
  const db = join(mkdtempSync(join(tmpdir(), 'cc-db3-')), 'test.db');
  const store = new Store(db);
  const sum = await importClaudeCode(store, { root, sinceMs: Date.now() - 24 * 60 * 60 * 1000 });
  assert.equal(sum.inserted, 1, 'only the recent request clears the cutoff');
  store.close();
});

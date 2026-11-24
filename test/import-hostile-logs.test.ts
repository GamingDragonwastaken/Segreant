/**
 * A tool's log is another program's output: cut short, half written, or from a
 * version nobody has seen. A record that makes no sense is passed over. It never
 * stops the import, the records around it, or the files after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { importClaudeCode } from '../src/connect/claudeCode.ts';
import { importCodex } from '../src/connect/codex.ts';

const STRANGE: unknown[] = [null, 1, 'text', [], {}, true, -1, 1.5, 1e308, '12', { nested: null }];

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'hostile-db-')), 'db.sqlite'));
}

test('a Codex log full of records that make no sense still gives up its good ones, and the next file is read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hostile-codex-'));
  const day = join(root, 'sessions', '2026', '11', '01');
  mkdirSync(day, { recursive: true });
  const record = (type: unknown, payload: unknown, timestamp: unknown = '2026-11-01T10:00:00Z') => JSON.stringify({ timestamp, type, payload });
  const count = (n: number) => record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 50 * n, output_tokens: 10 * n } } });
  const lines = (id: string): string[] => [record('session_meta', { id, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5.5' }), count(1)];
  const bad = STRANGE.flatMap((x) => [
    JSON.stringify(x),
    record('session_meta', x), record('turn_context', x), record('event_msg', x), record(x, {}),
    record('event_msg', { type: 'token_count', info: x }),
    record('event_msg', { type: 'token_count', info: { total_token_usage: x, last_token_usage: x } }),
    record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: x, cached_input_tokens: x, output_tokens: x } }, rate_limits: x }),
    record('event_msg', { type: 'task_started', turn_id: x, started_at: x }),
    record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } }, x),
    record('turn_context', { model: x, cwd: x, turn_id: x }),
  ]);
  writeFileSync(join(day, 'rollout-a.jsonl'), [...lines('thread-a'), ...bad, '{"cut sh'].join('\n'));
  writeFileSync(join(day, 'rollout-b.jsonl'), lines('thread-b').join('\n') + '\n');
  const store = freshStore();
  try {
    await importCodex(store, { root });
    const ids = store.requestsInRange(0, Date.now() + 86_400_000).map((r) => r.requestId);
    assert.ok(ids.includes('codex:thread-a:0'), 'the good record before the strange ones');
    assert.ok(ids.includes('codex:thread-b:0'), 'the file after them');
  } finally {
    store.close();
  }
});

test('a Claude Code log full of records that make no sense still gives up its good ones, and the next file is read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hostile-claude-'));
  mkdirSync(join(root, 'proj'));
  const entry = (over: Record<string, unknown>) => JSON.stringify({ type: 'assistant', requestId: 'req_x', sessionId: 's', cwd: '/work/app', timestamp: '2026-11-01T10:00:00Z', message: { id: 'msg_x', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } }, ...over });
  const good = (id: string) => entry({ requestId: id, message: { id: `msg_${id}`, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } });
  const bad = STRANGE.flatMap((x, i) => [
    JSON.stringify(x),
    entry({ requestId: `req_m${i}`, message: x }),
    entry({ requestId: `req_u${i}`, message: { id: 'm', model: 'claude-opus-5', usage: x } }),
    entry({ requestId: `req_t${i}`, message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: x, output_tokens: x, cache_read_input_tokens: x, cache_creation_input_tokens: x, cache_creation: x } } }),
    entry({ requestId: `req_d${i}`, message: { id: 'm', model: x, usage: { input_tokens: 1, output_tokens: 1 } } }),
    entry({ requestId: x, timestamp: x, sessionId: x, cwd: x }),
    entry({ requestId: `req_c${i}`, sessionId: x, cwd: x }),
  ]);
  writeFileSync(join(root, 'proj', 'a.jsonl'), [good('req_a'), ...bad, '{"cut sh'].join('\n'));
  writeFileSync(join(root, 'proj', 'b.jsonl'), good('req_b') + '\n');
  const store = freshStore();
  try {
    await importClaudeCode(store, { root });
    const rows = store.requestsInRange(0, Date.now() + 86_400_000);
    const ids = rows.map((r) => r.requestId);
    assert.ok(ids.includes('req_a'));
    assert.ok(ids.includes('req_b'));
    for (const r of rows) assert.ok([r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens].every((n) => Number.isSafeInteger(n) && n >= 0), r.requestId);
  } finally {
    store.close();
  }
});

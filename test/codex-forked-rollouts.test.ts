/**
 * Forked Codex threads: a fork's rollout repeats the parent's session_meta id
 * and starts from the parent's cumulative totals. It must import under its own
 * id (not collide with the parent's rows) and must not re-bill the parent's
 * history carried in its first total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { parseCodexRollout, importCodex, codexForkThreadId } from '../src/connect/codex.ts';

const PARENT = '01a09c97-1058-7451-8461-e7e0d16685b2';
const CHILD = '01a0a989-eb8c-7b61-8bbc-ce4c84921ece';

type Usage = { input: number; cached: number; output: number };
const usage = (u: Usage) => ({ input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output, reasoning_output_tokens: 0, total_tokens: u.input + u.output });

function rollout(file: string, events: Array<{ ts: string; total: Usage; last?: Usage }>): void {
  const lines = [JSON.stringify({ timestamp: '2026-09-22T10:00:00.000Z', type: 'session_meta', payload: { id: PARENT, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5.5', source: 'vscode' } })];
  for (const e of events) {
    const info: Record<string, unknown> = { total_token_usage: usage(e.total) };
    if (e.last) info.last_token_usage = usage(e.last);
    lines.push(JSON.stringify({ timestamp: e.ts, type: 'event_msg', payload: { type: 'token_count', info } }));
  }
  writeFileSync(file, lines.join('\n') + '\n');
}

function setup(): { root: string; parentFile: string; childFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'codex-fork-'));
  const day = join(root, 'sessions', '2026', '09', '22');
  mkdirSync(day, { recursive: true });
  const parentFile = join(day, `rollout-2026-09-22T10-00-00-${PARENT}.jsonl`);
  const childFile = join(day, `rollout-2026-09-22T11-00-00-${PARENT}_${CHILD}.jsonl`);
  rollout(parentFile, [
    { ts: '2026-09-22T10:01:00.000Z', total: { input: 1000, cached: 0, output: 100 } },
    { ts: '2026-09-22T10:02:00.000Z', total: { input: 3000, cached: 1000, output: 300 } },
  ]);
  rollout(childFile, [
    // Carries the parent's 3000/300 plus this turn's 500/50.
    { ts: '2026-09-22T11:01:00.000Z', total: { input: 3500, cached: 1200, output: 350 }, last: { input: 500, cached: 200, output: 50 } },
    { ts: '2026-09-22T11:02:00.000Z', total: { input: 4200, cached: 1500, output: 420 }, last: { input: 700, cached: 300, output: 70 } },
  ]);
  return { root, parentFile, childFile };
}

test('the child id is read from the fork filename, ordinary files have none', () => {
  assert.equal(codexForkThreadId(`rollout-2026-09-22T11-00-00-${PARENT}_${CHILD}.jsonl`), CHILD);
  assert.equal(codexForkThreadId(`rollout-2026-09-22T10-00-00-${PARENT}.jsonl`), null);
});

test('a fork is keyed by its own id and counts only its own turns', async () => {
  const { childFile } = setup();
  const rows = await parseCodexRollout(childFile);
  assert.deepEqual(rows.map((r) => r.requestId), [`codex:${CHILD}:0`, `codex:${CHILD}:1`]);
  assert.equal(rows[0]!.sessionId, CHILD);
  // Turn 1: last_token_usage 500 input of which 200 cached, 50 output.
  assert.deepEqual([rows[0]!.inputTokens, rows[0]!.cacheReadTokens, rows[0]!.outputTokens], [300, 200, 50]);
  // Turn 2: the cumulative delta 700/300/70.
  assert.deepEqual([rows[1]!.inputTokens, rows[1]!.cacheReadTokens, rows[1]!.outputTokens], [400, 300, 70]);
});

test('importing parent and fork records both, with no conflicts', async () => {
  const { root } = setup();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codex-fork-db-')), 'db.sqlite'));
  try {
    const summary = await importCodex(store, { root });
    assert.equal(summary.inserted, 4);
    assert.equal(summary.conflictingObservations ?? 0, 0);
    const again = await importCodex(store, { root });
    assert.equal(again.inserted, 0);
  } finally {
    store.close();
  }
});

test('a subagent rollout keeps its own id when the parent session_meta follows it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-sub-'));
  const SUB = '01a09ca0-d624-7881-b8ce-076d9b240a40';
  const file = join(root, `rollout-2026-09-14T00-16-21-${SUB}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ timestamp: '2026-09-14T00:16:21.000Z', type: 'session_meta', payload: { id: SUB, forked_from_id: PARENT, thread_source: 'subagent', cwd: '/work/app' } }),
    JSON.stringify({ timestamp: '2026-09-14T00:16:21.000Z', type: 'session_meta', payload: { id: PARENT, thread_source: 'user', cwd: '/work/app' } }),
    JSON.stringify({ timestamp: '2026-09-14T00:17:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage({ input: 900, cached: 0, output: 90 }), last_token_usage: usage({ input: 900, cached: 0, output: 90 }) } } }),
  ].join('\n') + '\n');
  const rows = await parseCodexRollout(file);
  assert.deepEqual(rows.map((r) => r.requestId), [`codex:${SUB}:0`]);
  assert.equal(rows[0]!.inputTokens, 900);
});

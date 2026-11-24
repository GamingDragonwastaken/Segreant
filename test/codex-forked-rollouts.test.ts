/**
 * Forked Codex threads: a fork's rollout repeats the parent's session_meta id
 * and starts from the parent's cumulative totals. It must import under its own
 * id (not collide with the parent's rows) and must not re-bill the parent's
 * history carried in its first total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const line = (type: string, payload: Record<string, unknown>, ts = '2026-09-22T11:00:00.000Z') => JSON.stringify({ timestamp: ts, type, payload });
const counted = (total: Usage, last: Usage, ts?: string) => line('event_msg', { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last) } }, ts);
const FORK = '01a0a989-eb8c-7b61-8bbc-ce4c84921ece';
const PARENT_TURN = '01a0a980-0000-7000-8000-000000000001';
const FORK_TURN = '01a0a989-f000-7000-8000-000000000002';

/** A forked thread that opens with two of its parent's requests before its own first one. */
function replayingFork(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'codex-replay-'));
  const day = join(root, 'sessions', '2026', '09', '22');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-09-22T11-00-00-${FORK}.jsonl`);
  writeFileSync(file, [
    line('session_meta', { id: FORK, forked_from_id: PARENT, parent_thread_id: PARENT, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5.5' }),
    counted({ input: 10_000, cached: 8_000, output: 100 }, { input: 0, cached: 0, output: 0 }),
    line('event_msg', { type: 'task_started', turn_id: 'rollout-4', started_at: 1790074800 }),
    counted({ input: 11_000, cached: 8_800, output: 150 }, { input: 1000, cached: 800, output: 50 }),
    line('event_msg', { type: 'task_started', turn_id: PARENT_TURN, started_at: 1790074800 }),
    counted({ input: 12_500, cached: 10_000, output: 210 }, { input: 1500, cached: 1200, output: 60 }),
    line('event_msg', { type: 'task_started', turn_id: FORK_TURN, started_at: 1790074900 }),
    line('turn_context', { turn_id: FORK_TURN, model: 'gpt-5.5', cwd: '/work/app' }),
    counted({ input: 13_000, cached: 10_300, output: 230 }, { input: 500, cached: 300, output: 20 }, '2026-09-22T11:02:00.000Z'),
  ].join('\n') + '\n');
  return { root, file };
}

test('a fork does not count the parent requests its log replays', async () => {
  const { file } = replayingFork();
  const replayed: string[] = [];
  const rows = await parseCodexRollout(file, { onReplayed: (id) => replayed.push(id) });
  assert.deepEqual(rows.map((r) => [r.requestId, r.inputTokens, r.cacheReadTokens, r.outputTokens]), [[`codex:${FORK}:2`, 200, 300, 20]]);
  assert.deepEqual(replayed, [`codex:${FORK}:0`, `codex:${FORK}:1`]);
});

test('an import sets replayed requests an earlier version counted to zero, once, and keeps what they were', async () => {
  const { root, file } = replayingFork();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codex-replay-db-')), 'db.sqlite'));
  try {
    const first = await importCodex(store, { root });
    assert.equal(first.inserted, 1);
    const own = store.spendBetween(0, Date.parse('2027-01-01'));
    // What an earlier version left behind for the two replayed requests.
    const template = { sessionId: FORK, tsEpochMs: Date.parse('2026-09-22T11:00:00.000Z'), provider: 'openai', model: 'gpt-5.5', project: 'app', taskWeight: 1,
      cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.5, estimated: false, streamed: true, statusCode: 200, durationMs: null, source: 'codex', cwd: '/work/app', via: 'import' as const };
    store.insertRequestIfNew({ ...template, requestId: `codex:${FORK}:0`, inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 });
    store.insertRequestIfNew({ ...template, requestId: `codex:${FORK}:1`, inputTokens: 300, outputTokens: 60, cacheReadTokens: 1200 });
    assert.ok(store.spendBetween(0, Date.parse('2027-01-01')) > own);
    appendFileSync(file, JSON.stringify({}) + String.fromCharCode(10));
    const second = await importCodex(store, { root });
    assert.equal(second.retractedObservations, 2);
    assert.equal(store.spendBetween(0, Date.parse('2027-01-01')), own);
    assert.equal(store.requestPriceEvents(`codex:${FORK}:0`)[0]!.previousCostUsd, 0.5);
    assert.equal((await importCodex(store, { root })).retractedObservations ?? 0, 0);
  } finally {
    store.close();
  }
});

test('a total that restarts counts the turn itself and leaves later ids in place', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-reset-'));
  const file = join(root, `rollout-2026-09-22T11-00-00-${FORK}.jsonl`);
  writeFileSync(file, [
    line('session_meta', { id: FORK, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5.5' }),
    counted({ input: 5000, cached: 1000, output: 100 }, { input: 5000, cached: 1000, output: 100 }),
    counted({ input: 700, cached: 200, output: 30 }, { input: 700, cached: 200, output: 30 }),
    counted({ input: 1500, cached: 600, output: 70 }, { input: 800, cached: 400, output: 40 }),
  ].join('\n') + '\n');
  const rows = await parseCodexRollout(file);
  assert.deepEqual(rows.map((r) => [r.requestId.split(':')[2], r.inputTokens, r.cacheReadTokens, r.outputTokens]), [['0', 4000, 1000, 100], ['reset-0', 500, 200, 30], ['1', 400, 400, 40]]);
});

test('a shortened log that restamps every line keeps each turn at the time it began', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-restamp-'));
  const file = join(root, `rollout-2026-09-22T11-00-00-${FORK}.jsonl`);
  writeFileSync(file, [
    line('session_meta', { id: FORK, parent_thread_id: PARENT, cwd: '/work/app', model_provider: 'openai', model: 'gpt-5.5' }),
    // Not a fork: the carried total is this thread's own earlier work.
    counted({ input: 9000, cached: 8000, output: 90 }, { input: 0, cached: 0, output: 0 }),
    line('event_msg', { type: 'task_started', turn_id: FORK_TURN, started_at: Date.parse('2026-09-22T17:00:00.000Z') / 1000 }),
    counted({ input: 9500, cached: 8400, output: 100 }, { input: 500, cached: 400, output: 10 }),
  ].join('\n') + '\n');
  const rows = await parseCodexRollout(file);
  assert.deepEqual(rows.map((r) => r.inputTokens + r.cacheReadTokens), [9000, 500]);
  assert.equal(new Date(rows[1]!.tsEpochMs).toISOString(), '2026-09-22T17:00:00.000Z');
});

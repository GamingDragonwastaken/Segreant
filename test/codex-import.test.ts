/**
 * Codex importer: per-turn rows are DELTAS of the cumulative token_count total
 * (so they telescope to Codex's own session total, not the double-counting
 * last_token_usage), stable ids make it idempotent, unknown models price honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any user-level rate-card override (~/.fiscus/pricing/models.json):
// these tests assert bundled-table pricing, and a developer's own `pricing --refresh`
// must not change what they see. Each test file runs in its own process, so this is airtight.
process.env.FISCUS_HOME = mkdtempSync(join(tmpdir(), 'fiscus-home-'));
import { Store } from '../src/store/db.ts';
import { parseCodexRollout, importCodex } from '../src/connect/codex.ts';

/** Build a rollout file with a session_meta + a sequence of cumulative token totals. */
function makeRollout(root: string, sessionId: string, totals: Array<{ ts: string; input: number; cached: number; output: number; reasoning: number }>): void {
  const day = join(root, 'sessions', '2026', '06', '08');
  mkdirSync(day, { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      timestamp: '2026-06-08T11:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\dev\\projects\\game', model_provider: 'openai', model: 'gpt-5.5' },
    }),
  ];
  for (const t of totals) {
    lines.push(
      JSON.stringify({
        timestamp: t.ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: t.input, cached_input_tokens: t.cached, output_tokens: t.output, reasoning_output_tokens: t.reasoning, total_tokens: t.input + t.output },
          },
        },
      }),
    );
  }
  writeFileSync(join(day, `rollout-${sessionId}.jsonl`), lines.join('\n'), 'utf8');
}

test('codex parse: each turn is the delta of the cumulative total, telescoping exactly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-'));
  makeRollout(root, 'sess-1', [
    { ts: '2026-06-08T11:01:00.000Z', input: 1000, cached: 100, output: 200, reasoning: 50 },
    { ts: '2026-06-08T11:02:00.000Z', input: 1800, cached: 300, output: 350, reasoning: 90 }, // delta: in 800, cached 200, out 150
    { ts: '2026-06-08T11:03:00.000Z', input: 1800, cached: 300, output: 350, reasoning: 90 }, // no new work -> no row
  ]);
  const file = join(root, 'sessions', '2026', '06', '08', 'rollout-sess-1.jsonl');
  const rows = await parseCodexRollout(file);
  assert.equal(rows.length, 2, 'the idempotent no-op event produces no row');
  // Row 0: uncached input = 1000-100 = 900, cache read 100, output 200.
  assert.equal(rows[0]!.inputTokens, 900);
  assert.equal(rows[0]!.cacheReadTokens, 100);
  assert.equal(rows[0]!.outputTokens, 200);
  // Row 1: delta input 800, delta cached 200 -> uncached 600; cache read 200; output 150.
  assert.equal(rows[1]!.inputTokens, 600);
  assert.equal(rows[1]!.cacheReadTokens, 200);
  assert.equal(rows[1]!.outputTokens, 150);
  // Telescoping: summed uncached+cached input = final cumulative input (1800).
  const totalInput = rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens, 0);
  assert.equal(totalInput, 1800, 'deltas sum to Codex own cumulative total — no double count');
  assert.equal(rows[0]!.model, 'gpt-5.5');
  assert.equal(rows[0]!.project, 'game');
  assert.equal(rows[0]!.cwd, 'C:\\Users\\dev\\projects\\game', 'full cwd captured for repo auto-correlation');
});

test('codex import: idempotent by stable per-turn id; unknown model priced as honest estimate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex2-'));
  makeRollout(root, 'sess-A', [
    { ts: '2026-06-08T11:01:00.000Z', input: 1000, cached: 0, output: 200, reasoning: 0 },
    { ts: '2026-06-08T11:02:00.000Z', input: 2000, cached: 0, output: 400, reasoning: 0 },
  ]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codex-store-')), 'test.db'));

  const first = await importCodex(store, { root });
  assert.equal(first.inserted, 2);
  assert.ok(first.estimatedCostUsd > 0, 'gpt-5.5 is not in the rate card -> honestly flagged estimated');
  assert.equal(first.estimatedCostUsd, first.costUsd, 'the whole cost is an estimate here');

  const again = await importCodex(store, { root });
  assert.equal(again.inserted, 0, 'stable codex:<session>:<ordinal> ids block duplicates');

  const bySource = store.bySource(0, Date.now());
  assert.equal(bySource[0]!.label, 'codex');
  store.close();
});

test('codex import: a compaction reset (total drops) never produces negative tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex3-'));
  makeRollout(root, 'sess-c', [
    { ts: '2026-06-08T11:01:00.000Z', input: 5000, cached: 0, output: 1000, reasoning: 0 },
    { ts: '2026-06-08T11:02:00.000Z', input: 500, cached: 0, output: 100, reasoning: 0 }, // reset: deltas clamp to 0
    { ts: '2026-06-08T11:03:00.000Z', input: 900, cached: 0, output: 200, reasoning: 0 }, // delta in 400, out 100
  ]);
  const file = join(root, 'sessions', '2026', '06', '08', 'rollout-sess-c.jsonl');
  const rows = await parseCodexRollout(file);
  for (const r of rows) {
    assert.ok(r.inputTokens >= 0 && r.outputTokens >= 0, 'no negative tokens across a reset');
  }
});

test('codex import: no Codex install is an honest empty result', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codex-store2-')), 'test.db'));
  const sum = await importCodex(store, { root: join(tmpdir(), 'no-codex-here') });
  assert.deepEqual([sum.eventsSeen, sum.inserted], [0, 0]);
  store.close();
});

test('codex import: oversized rollout lines are skipped before JSON.parse and disclosed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-large-line-'));
  const day = join(root, 'sessions', '2026', '06', '08');
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, 'rollout-large.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'sess-large' } })}\n${'x'.repeat(2 * 1024 * 1024 + 1)}`,
    'utf8',
  );
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codex-large-db-')), 'test.db'));
  const sum = await importCodex(store, { root });
  assert.equal(sum.eventsSeen, 0);
  assert.equal(sum.captureCoverage, 'truncated');
  assert.equal(sum.truncatedLines, 1);
  store.close();
});

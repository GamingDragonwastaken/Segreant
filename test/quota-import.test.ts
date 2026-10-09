/**
 * The importers keep the vendors' meters: Codex readings only when they change,
 * Claude limit messages only from the vendor's own error line.
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

const store = () => new Store(join(mkdtempSync(join(tmpdir(), 'quota-db-')), 'test.db'));

test('Codex: a rate-limit reading is stored when it changes, not on every token count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-quota-'));
  const day = join(root, 'sessions', '2026', '10', '01');
  mkdirSync(day, { recursive: true });
  const count = (ts: string, input: number, used: number) => JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: input + 10 } },
      rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1_791_500_000 }, plan_type: 'plus' },
    },
  });
  writeFileSync(join(day, 'rollout-2026-10-01T10-00-00-01a09c97-1058-7451-8461-e7e0d16685b2.jsonl'), [
    JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', cwd: '/work/app' } }),
    count('2026-10-01T10:01:00.000Z', 100, 10),
    count('2026-10-01T10:02:00.000Z', 200, 10),
    count('2026-10-01T10:03:00.000Z', 300, 12),
  ].join('\n') + '\n', 'utf8');
  const s = store();
  await importCodex(s, { root });
  assert.deepEqual(s.quotaEvents().map((e) => [e.kind, e.usedPercent]), [['codex_primary', 10], ['codex_primary', 12]]);
  s.close();
});

test('Claude Code: the vendor limit line is stored once; a quoted copy is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-quota-'));
  const vendor = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, timestamp: '2026-10-05T14:00:00.000Z', sessionId: 's',
    message: { content: [{ type: 'text', text: "You've hit your session limit · resets 6:40pm (Africa/Cairo)" }] },
  });
  const quoted = JSON.stringify({
    type: 'user', timestamp: '2026-10-05T14:05:00.000Z', sessionId: 's',
    message: { content: "it said You've hit your session limit · resets 6:40pm (Africa/Cairo)" },
  });
  writeFileSync(join(root, 's.jsonl'), vendor + '\n' + quoted + '\n', 'utf8');
  const s = store();
  await importClaudeCode(s, { root });
  await importClaudeCode(s, { root, rescan: true });
  const events = s.quotaEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'claude_session');
  assert.equal(events[0]!.resetsAtMs, Date.parse('2026-10-05T15:40:00.000Z'));
  s.close();
});

/**
 * Commit observations: an agent's own log shows git creating a commit
 * ("[main 3f60dcf] subject"). The importers record which session made which
 * commit; a Codex fork does not inherit the commits replayed from its parent;
 * and a file read by an older reader is read again so history is captured.
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
import { commitObservationsInLine, IMPORT_READER_VERSION } from '../src/connect/importShared.ts';

const store = () => new Store(join(mkdtempSync(join(tmpdir(), 'obs-db-')), 'test.db'));

test('git commit lines are found in raw log lines, and ordinary brackets are not', () => {
  const line = (text: string) => JSON.stringify({ content: text });
  assert.deepEqual(commitObservationsInLine(line('[main 6a79dd4] Point Dependabot at the code\n 2 files changed')),
    [{ branch: 'main', shortSha: '6a79dd4', subject: 'Point Dependabot at the code' }]);
  assert.deepEqual(commitObservationsInLine(line('[main (root-commit) abc1234] Initial commit\n')),
    [{ branch: 'main', shortSha: 'abc1234', subject: 'Initial commit' }]);
  assert.deepEqual(commitObservationsInLine(line('[claude/x-y 0f1e2d3] Say "kept"\n')),
    [{ branch: 'claude/x-y', shortSha: '0f1e2d3', subject: 'Say "kept"' }]);
  assert.deepEqual(commitObservationsInLine(line('an array [1, 2] and [note] text')), []);
});

test('Claude Code: a tool result showing a commit records its session, time and directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-obs-'));
  const toolResult = JSON.stringify({
    type: 'user', sessionId: 'sess-7', timestamp: '2026-10-01T09:30:05.000Z', cwd: 'C:\\work\\app',
    message: { content: [{ type: 'tool_result', content: '[main 1a2b3c4] Fix the import\n 1 file changed' }] },
  });
  const noSession = JSON.stringify({ type: 'user', timestamp: '2026-10-01T09:31:00.000Z', message: { content: '[main 9f8e7d6] Orphan line' } });
  writeFileSync(join(root, 's.jsonl'), toolResult + '\n' + noSession + '\n', 'utf8');
  const s = store();
  await importClaudeCode(s, { root });
  assert.deepEqual(s.observedCommits(), [{
    source: 'claude-code', sessionId: 'sess-7', shortSha: '1a2b3c4', branch: 'main', subject: 'Fix the import',
    tsEpochMs: Date.parse('2026-10-01T09:30:05.000Z'), cwd: 'C:\\work\\app',
  }], 'a line with no session id is not attributed to anyone');
  // Re-reading the same file records nothing twice.
  await importClaudeCode(s, { root, rescan: true });
  assert.equal(s.observedCommits().length, 1);
  s.close();
});

test('a file read by an older reader is read once more, then skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-obs-ver-'));
  const file = join(root, 's.jsonl');
  writeFileSync(file, JSON.stringify({
    type: 'user', sessionId: 'sess-8', timestamp: '2026-10-01T10:00:00.000Z',
    message: { content: '[main 5e6f7a8] Add a check' },
  }) + '\n', 'utf8');
  const s = store();
  await importClaudeCode(s, { root });
  // Simulate a cursor left by the version-1 reader, which captured no commits.
  s.raw().prepare('DELETE FROM observed_commits').run();
  s.raw().prepare('UPDATE import_file_cursors SET reader_version = 1').run();
  const reread = await importClaudeCode(s, { root });
  assert.equal(reread.filesUnchanged ?? 0, 0, 'an older reader\'s cursor is not trusted');
  assert.equal(s.observedCommits().length, 1, 'history is captured on the re-read');
  const again = await importClaudeCode(s, { root });
  assert.equal(again.filesUnchanged, 1);
  assert.equal(IMPORT_READER_VERSION, 3);
  s.close();
});

test('Codex: a fork records its own commits, not the ones replayed from its parent', async () => {
  const PARENT = '01a09c97-1058-7451-8461-e7e0d16685b2';
  const CHILD = '01a0a989-eb8c-7b61-8bbc-ce4c84921ece';
  const root = mkdtempSync(join(tmpdir(), 'codex-obs-'));
  const day = join(root, 'sessions', '2026', '10', '01');
  mkdirSync(day, { recursive: true });
  const count = (ts: string, input: number) => JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: input + 10 } } },
  });
  const output = (ts: string, text: string) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', output: text } });
  writeFileSync(join(day, `rollout-2026-10-01T11-00-00-${PARENT}_${CHILD}.jsonl`), [
    JSON.stringify({ timestamp: '2026-10-01T11:00:00.000Z', type: 'session_meta', payload: { id: PARENT, cwd: '/work/app' } }),
    output('2026-10-01T10:30:00.000Z', '[main aaaaaaa] Parent work, replayed'),
    count('2026-10-01T11:01:00.000Z', 1000),
    output('2026-10-01T11:02:00.000Z', '[main bbbbbbb] Child work'),
  ].join('\n') + '\n', 'utf8');
  const s = store();
  await importCodex(s, { root });
  const seen = s.observedCommits().map((o) => [o.sessionId, o.shortSha, o.subject]);
  assert.deepEqual(seen, [[CHILD, 'bbbbbbb', 'Child work']]);
  s.close();
});

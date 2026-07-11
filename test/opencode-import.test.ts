/**
 * opencode importer: reads the local session DB read-only, keeps opencode's own
 * cost (0 is legitimate for free models), dedupes by message id, idempotent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any user-level rate-card override (~/.aegisflow/pricing/models.json):
// these tests assert bundled-table pricing, and a developer's own `pricing --refresh`
// must not change what they see. Each test file runs in its own process, so this is airtight.
process.env.AEGIS_HOME = mkdtempSync(join(tmpdir(), 'aegis-home-'));
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store/db.ts';
import { parseOpencodeMessage, importOpencode } from '../src/connect/opencode.ts';

function makeOpencodeDb(rows: Array<{ id: string; session: string; data: unknown; tc?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-db-'));
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const ins = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.session, r.tc ?? 1779042360836, JSON.stringify(r.data));
  db.close();
  return path;
}

function assistant(over: Record<string, unknown> = {}): unknown {
  return {
    role: 'assistant',
    providerID: 'opencode',
    modelID: 'deepseek-v4-flash-free',
    cost: 0,
    tokens: { input: 200, output: 500, reasoning: 8, cache: { read: 1000, write: 0 } },
    time: { created: 1779042360836, completed: 1779042361863 },
    path: { cwd: 'C:\\Users\\dev\\projects\\my-app', root: '/' },
    ...over,
  };
}

test('opencode parse: pulls tokens, provider/model, and project from cwd basename', () => {
  const ev = parseOpencodeMessage('msg_1', JSON.stringify(assistant()));
  assert.ok(ev);
  assert.equal(ev.provider, 'opencode');
  assert.equal(ev.model, 'deepseek-v4-flash-free');
  assert.equal(ev.project, 'my-app');
  assert.equal(ev.inputTokens, 200);
  assert.equal(ev.cacheReadTokens, 1000);
  assert.equal(ev.reportedCostUsd, 0);
});

test('opencode parse: non-assistant, zero-token, and torn rows are all null', () => {
  assert.equal(parseOpencodeMessage('x', JSON.stringify({ role: 'user' })), null);
  assert.equal(parseOpencodeMessage('x', '{torn'), null);
  assert.equal(
    parseOpencodeMessage('x', JSON.stringify(assistant({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))),
    null,
    'a no-token turn is a placeholder, not traffic',
  );
});

test('opencode import: reads the DB read-only, tags source, and re-import adds nothing', () => {
  const dbPath = makeOpencodeDb([
    { id: 'msg_1', session: 'ses_1', data: assistant() },
    { id: 'msg_2', session: 'ses_1', data: assistant({ tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } }) },
    { id: 'msg_u', session: 'ses_1', data: { role: 'user', text: 'hi' } }, // ignored
  ]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'oc-store-')), 'test.db'));

  const first = importOpencode(store, { root: dbPath });
  assert.equal(first.eventsSeen, 2);
  assert.equal(first.inserted, 2);
  assert.equal(first.costUsd, 0, 'free-tier models are honestly $0 — RoI still scores them (dollar-free core)');

  const again = importOpencode(store, { root: dbPath });
  assert.equal(again.inserted, 0, 'idempotent by message id');

  const bySource = store.bySource(0, Date.now());
  assert.equal(bySource[0]!.label, 'opencode');
  assert.equal(store.summary(0, Date.now()).requests, 2);
  store.close();
});

test('opencode import: re-prices a paid model only when opencode reported 0 and we hold an EXACT rate', () => {
  const dbPath = makeOpencodeDb([
    // opencode ran opus but logged cost 0 -> our exact rate fills it in.
    { id: 'm_opus', session: 's', data: assistant({ providerID: 'anthropic', modelID: 'claude-opus-4-8', cost: 0, tokens: { input: 1_000_000, output: 0, cache: { read: 0, write: 0 } } }) },
    // A model we don't have an exact rate for stays at opencode's honest 0.
    { id: 'm_free', session: 's', data: assistant({ providerID: 'someprov', modelID: 'mystery-model', cost: 0 }) },
  ]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'oc-store2-')), 'test.db'));
  const sum = importOpencode(store, { root: dbPath });
  assert.ok(sum.costUsd > 0, 'opus at 1M input priced from our exact rate');
  assert.equal(sum.byModel['mystery-model']!.costUsd, 0, 'unknown model is not invented into a cost');
  store.close();
});

test('opencode import: a missing database is an honest empty result, not a crash', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'oc-store3-')), 'test.db'));
  const sum = importOpencode(store, { root: join(tmpdir(), 'nope', 'opencode.db') });
  assert.deepEqual([sum.files, sum.eventsSeen, sum.inserted], [0, 0, 0]);
  store.close();
});

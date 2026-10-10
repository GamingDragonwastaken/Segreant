/**
 * Claude Code's status line hands Segreant the live usage meter. The lean path
 * records a reading only when it changed, never creates the ledger, and always
 * prints a line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { Store } from '../src/store/db.ts';
import { claudeStatuslineEvents } from '../src/quota/limits.ts';
import { statuslineLine } from '../src/quota/statusline.ts';
import { quotaView } from '../src/quota/view.ts';

const INPUT = (five: number) => JSON.stringify({
  model: { id: 'claude-opus' },
  rate_limits: {
    five_hour: { used_percentage: five, resets_at: 1_791_600_000 },
    seven_day: { used_percentage: 41, resets_at: 1_792_000_000 },
  },
});

test('status line input: each present window becomes a reading; absent or malformed ones do not', () => {
  const ev = claudeStatuslineEvents(JSON.parse(INPUT(23.5)), 1_000);
  assert.deepEqual(ev.map((e) => [e.kind, e.usedPercent, e.windowMinutes, e.resetsAtMs]), [
    ['claude_five_hour', 23.5, 300, 1_791_600_000_000],
    ['claude_seven_day', 41, 10_080, 1_792_000_000_000],
  ]);
  assert.deepEqual(claudeStatuslineEvents({ model: {} }, 1_000), [], 'API-key sessions carry no rate_limits');
  assert.deepEqual(claudeStatuslineEvents({ rate_limits: { five_hour: { used_percentage: 'x' } } }, 1_000), []);
});

test('the lean path records a reading only when it changes, and quota shows it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sl-db-')), 'segreant.db');
  new Store(file).close(); // an ordinary run created the ledger and its tables
  assert.match(statuslineLine(file, INPUT(10), 1_000), /^5h 10% · week 41% · today \$0\.00 list$/);
  statuslineLine(file, INPUT(10), 2_000);
  statuslineLine(file, INPUT(12), 3_000);
  const store = new Store(file);
  const five = store.quotaEvents().filter((e) => e.kind === 'claude_five_hour');
  assert.deepEqual(five.map((e) => [e.tsEpochMs, e.usedPercent]), [[1_000, 10], [3_000, 12]]);
  const view = quotaView(store.quotaEvents(), () => 0, 3_000);
  assert.deepEqual(view.claudeWindows.map((w) => [w.kind, w.usedPercent]), [['claude_five_hour', 12], ['claude_seven_day', 41]]);
  store.close();
});

test('no ledger, garbage, or nothing on stdin: still one line, and no file is created', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'sl-none-')), 'segreant.db');
  assert.equal(statuslineLine(missing, INPUT(5), 1_000), '5h 5% · week 41%');
  assert.equal(statuslineLine(missing, 'not json', 1_000), 'segreant');
  assert.equal(statuslineLine(missing, '', 1_000), 'segreant');
});

test('setup names the installed file, so nothing has to be on PATH (H012)', async () => {
  const { statuslineSetupText } = await import('../src/cli/quotaCmd.ts');
  const local = statuslineSetupText('C:/Users/me/proj/node_modules/segreant/bin/segreant.mjs');
  const line = local.split('\n').find((l) => l.includes('"statusLine"'))!;
  const settings = JSON.parse(`{${line.trim()}}`) as { statusLine: { type: string; command: string } };
  assert.deepEqual(settings.statusLine, {
    type: 'command',
    command: 'node "C:/Users/me/proj/node_modules/segreant/bin/segreant-statusline.mjs"',
  }, 'a settings line that parses as JSON and runs the installed file');
  const npx = statuslineSetupText('C:/Users/me/AppData/Local/npm-cache/_npx/abc/node_modules/segreant/bin/segreant.mjs');
  assert.match(npx, /npm install -g segreant/);
  assert.doesNotMatch(npx, /"statusLine"/, 'no path into a cache that can be cleared');
});

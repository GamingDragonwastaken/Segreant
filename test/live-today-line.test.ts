// The proxy's live log states the spend the daily cap counts, beside the cap.
// The all-sources total read "today $51.29" next to a $25 cap while requests
// went through: imported spend does not count toward the cap by default
// (launch pass, 2026-10-18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-live-today-'));
process.env.SEGREANT_HOME = home;
const { Store } = await import('../src/store/db.ts');
const { liveTodayLine } = await import('../src/cli/runCmd.ts');

test('with a cap, the live line shows the counted spend and names imported spend apart', () => {
  const store = new Store(join(home, 'l.db'));
  const now = Date.now();
  const row = (id: string, costUsd: number, via: 'proxy' | 'import') => store.insertRequest({
    requestId: id, sessionId: null, tsEpochMs: now - 1_000, provider: 'anthropic', model: 'claude-sonnet-4-6', project: 'p', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
    statusCode: 200, durationMs: 1, via, ...(via === 'import' ? { source: 'claude-code' } : {}),
  });
  try {
    row('live', 3, 'proxy');
    row('imported', 48, 'import');
    assert.equal(liveTodayLine(store, { dailyUsd: 25, capIncludesImported: false }, now), 'today $3.00 of the $25.00 cap (+$48.00 imported, not counted)');
    assert.equal(liveTodayLine(store, { dailyUsd: 25, capIncludesImported: true }, now), 'today $51.00 of the $25.00 cap');
    assert.equal(liveTodayLine(store, { dailyUsd: null, capIncludesImported: false }, now), 'today $51.00', 'no cap: the plain total');
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The dashboard's value read: the stored realization when one exists, and
 * repeated row reads served once inside a report without changing the answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-value-read-'));
import { Store, type RequestRow } from '../src/store/db.ts';
import { loadRealization } from '../src/value/realization.ts';

const row = (id: string, ts: number, via: 'proxy' | 'import'): RequestRow => ({
  requestId: id, sessionId: 's', tsEpochMs: ts, provider: 'openai', model: 'gpt-5', project: 'p', taskWeight: 1,
  inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 1,
  estimated: false, streamed: false, statusCode: 200, durationMs: 1, via,
});

test('inside a read snapshot, the same rows come back, and proxy-only is the full read filtered', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'snap-')), 'segreant.db'));
  const t = Date.now() - 60_000;
  store.insertRequest(row('a', t, 'proxy'));
  store.insertRequestIfNew(row('b', t + 1, 'import'));
  const plain = store.economicRequestRowsInRange(0, Date.now() + 1);
  const live = store.economicRequestRowsInRange(0, Date.now() + 1, { liveOnly: true });
  await store.withReadSnapshot(async () => {
    assert.deepEqual(store.economicRequestRowsInRange(0, Date.now() + 1).map((r) => r.requestId), plain.map((r) => r.requestId));
    assert.deepEqual(store.economicRequestRowsInRange(0, Date.now() + 1, { liveOnly: true }).map((r) => r.requestId), live.map((r) => r.requestId));
    const again = store.economicRequestRowsInRange(0, Date.now() + 1);
    again.pop();
    assert.equal(store.economicRequestRowsInRange(0, Date.now() + 1).length, plain.length, 'a caller mutating its array does not change the snapshot');
  });
  assert.deepEqual(live.map((r) => r.requestId), ['a']);
  store.close();
});

test('preferStored reads the stored realization without touching git', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pref-')), 'segreant.db'));
  // No stored units: nothing to prefer, and a path that is not a repository gives no live report either.
  assert.equal(await loadRealization(store, join(tmpdir(), 'not-a-repo-segreant'), { preferStored: true }), null);
  store.close();
});

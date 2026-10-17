import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { execFileSync } from 'node:child_process';

test('previewReprice and cmdReprice agree; apply writes the shared preview once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-reprice-preview-'));
  process.env.SEGREANT_HOME = home;
  process.env.SEGREANT_DB = join(home, 'ledger.db');
  process.env.SEGREANT_DEMO = '';
  const store = new Store(process.env.SEGREANT_DB);
  try {
    store.insertRequest({
      requestId: 'exact', provider: 'anthropic', model: 'claude-opus-4-8', costUsd: 19,
      sessionId: null, tsEpochMs: 1000, project: 'p', taskWeight: 1, inputTokens: 1_000_000, outputTokens: 0,
      cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, estimated: true, streamed: false, statusCode: 200, durationMs: 1,
    });
    const { previewReprice, applyReprice } = await import('../src/cost/reprice.ts');
    const preview = previewReprice(store);
    const cli = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'reprice', '--json'], {
      env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30_000,
    }));
    for (const key of ['estimatedRows', 'repriceable', 'stillEstimated', 'totalBeforeUsd', 'totalAfterUsd', 'priceEvidence'] as const) {
      assert.deepEqual(cli[key], preview[key], key);
    }
    assert.deepEqual(cli.byModel, preview.byModel.map(({ afterBasis: _basis, ...model }) => model));
    assert.deepEqual(store.requestPriceEvents('exact'), []);
    const applied = applyReprice(store);
    assert.deepEqual(applied.byModel, preview.byModel);
    assert.equal(applied.totalAfterUsd, preview.totalAfterUsd);
    assert.equal(store.requestPriceEvents('exact').length, 1);
    assert.equal(applyReprice(store).repriceable, 0);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-antigravity-generator-home-'));
import { Store } from '../src/store/db.ts';
import { importAntigravity } from '../src/connect/antigravity.ts';

test('synthetic Antigravity corpus manifest matches complete and recent imports', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'segreant-antigravity-corpus-'));
  const out = join(scratch, 'corpus');
  let full: Store | undefined;
  let recent: Store | undefined;
  try {
    const generated = spawnSync(process.execPath, [
      'scripts/generate-antigravity-corpus.mjs', '--out', out,
      '--files', '2', '--generators-per-file', '10', '--projects', '3', '--padding-bytes', '16',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      synthetic: boolean; root: string; files: number; generatorRows: number;
      expectedCalls: number; expectedRecentCalls: number; modelCounts: Record<string, number>;
    };
    assert.equal(manifest.synthetic, true);
    assert.equal(manifest.files, 2);
    assert.equal(manifest.generatorRows, 20);
    assert.equal(Object.values(manifest.modelCounts).reduce((sum, n) => sum + n, 0), manifest.expectedCalls);
    full = new Store(join(scratch, 'full.db'));
    const all = await importAntigravity(full, { root: manifest.root });
    assert.equal(all.inserted, manifest.expectedCalls);
    assert.equal(all.captureCoverage ?? 'complete', 'complete');
    recent = new Store(join(scratch, 'recent.db'));
    const month = await importAntigravity(recent, { root: manifest.root, sinceMs: Date.now() - 30 * 86_400_000 });
    assert.equal(month.inserted, manifest.expectedRecentCalls);
    assert.equal(month.captureCoverage ?? 'complete', 'complete');
  } finally {
    full?.close();
    recent?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

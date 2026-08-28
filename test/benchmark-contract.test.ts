import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'benchmark.mjs');

test('benchmark harness emits a finite, isolated observation contract', () => {
  const env = { ...process.env };
  delete env.FISCUS_HOME;
  delete env.FISCUS_DB;
  delete env.FISCUS_DEMO;
  const output = execFileSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SCRIPT, '--scale=small', '--iterations=1'],
    { cwd: ROOT, encoding: 'utf8', env },
  );
  const report = JSON.parse(output) as {
    benchmarkVersion: number;
    scales: string[];
    externalNetworkAttempted: boolean;
    credentialRead: boolean;
    packagedDistBytes: number;
    sourceRevision: string;
    cases: Array<{ scale: string; rows: number; observations: Record<string, Record<string, number>> }>;
  };
  assert.equal(report.benchmarkVersion, 1);
  assert.deepEqual(report.scales, ['small']);
  assert.equal(report.externalNetworkAttempted, false);
  assert.equal(report.credentialRead, false);
  assert.equal(report.packagedDistBytes > 0, true);
  assert.equal(report.sourceRevision.length > 0, true);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0]?.scale, 'small');
  assert.equal(report.cases[0]?.rows, 100);
  for (const observation of Object.values(report.cases[0]?.observations ?? {})) {
    const samples = observation.samples;
    assert.equal(typeof samples, 'number');
    assert.equal((samples ?? 0) >= 1, true);
    for (const key of ['minMs', 'medianMs', 'p95Ms', 'maxMs']) {
      const value = observation[key];
      assert.equal(Number.isFinite(value), true, `${key} must be finite`);
      assert.equal((value ?? -1) >= 0, true, `${key} must be non-negative`);
    }
  }
});

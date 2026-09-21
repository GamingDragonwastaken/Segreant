import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('causal plan CLI previews a family-wise plan without persisting or opening a study', () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-causal-plan-cli-'));
  const options = join(root, 'plan.json');
  try {
    writeFileSync(options, JSON.stringify({
      declaredAtMs: 1_000,
      maxLooks: 2,
      endpointsPerLook: 2,
      sliceIds: ['all'],
      targetFamilywiseErrorRate: 0.05,
    }));
    const stdout = execFileSync(process.execPath, ['bin/fiscus.mjs', 'causal', 'plan', '--study', 'missing-study', '--options', options, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FISCUS_HOME: root },
    });
    const payload = JSON.parse(stdout) as { operation: string; plannedActs: number; requiredActAlpha: number; warning: string };
    assert.equal(payload.operation, 'causal_inference_plan_preview');
    assert.equal(payload.plannedActs, 4);
    assert.equal(payload.requiredActAlpha, 0.0125);
    assert.match(payload.warning, /no plan was persisted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

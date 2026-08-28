import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.ts';
import { applySettingsPatch } from '../src/dashboard/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('loadConfig refuses malformed budget data instead of falling back to unlimited defaults', () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-invalid-budget-config-'));
  process.env.FISCUS_HOME = home;
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ budget: { dailyUsd: 'unlimited' } }), 'utf8');
    assert.throws(() => loadConfig(), /CONFIG_INVALID|budget|repair/i);
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('settings patch rejects invalid budget values instead of persisting an unenforceable cap', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  for (const budget of [
    { dailyUsd: -1 },
    { dailyUsd: Number.NaN },
    { dailyUsd: 'unlimited' },
    { sessionUsd: { value: 1 } },
    { runawayWindowSec: 0 },
  ]) {
    assert.throws(() => applySettingsPatch(base, { budget } as never), /invalid|budget|finite|positive/i);
  }
});

test('settings patch rejects unknown keys instead of silently dropping them', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  assert.throws(
    () => applySettingsPatch(base, { budget: { dailyUsd: 5, futureCap: 1 } } as never),
    /unknown|unsupported|budget/i,
  );
});

test('saveConfig retains the last known-good file while replacing the active config', () => {
  const previousHome = process.env.FISCUS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'fiscus-config-atomic-'));
  process.env.FISCUS_HOME = home;
  try {
    const first = structuredClone(DEFAULT_CONFIG);
    first.budget.dailyUsd = 10;
    saveConfig(first);
    const second = structuredClone(DEFAULT_CONFIG);
    second.budget.dailyUsd = 20;
    saveConfig(second);

    assert.equal(loadConfig().budget.dailyUsd, 20);
    const backup = JSON.parse(readFileSync(join(home, 'config.json.bak'), 'utf8')) as { budget: { dailyUsd: number } };
    assert.equal(backup.budget.dailyUsd, 10);
    assert.deepEqual(
      readdirSync(home).filter((name) => name.includes('.tmp-')),
      [],
      'temporary config files must not survive a successful replacement',
    );
  } finally {
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

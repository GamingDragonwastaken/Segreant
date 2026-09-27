import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireConfigMutationLock, loadConfig, mutateConfig, saveConfig, saveConfigWithLock } from '../src/config.ts';
import { applySettingsPatch } from '../src/dashboard/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('loadConfig refuses malformed budget data instead of falling back to unlimited defaults', () => {
  const previousHome = process.env.SEGREANT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'segreant-invalid-budget-config-'));
  process.env.SEGREANT_HOME = home;
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ budget: { dailyUsd: 'unlimited' } }), 'utf8');
    assert.throws(() => loadConfig(), /CONFIG_INVALID|budget|repair/i);
  } finally {
    if (previousHome === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previousHome;
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
  const previousHome = process.env.SEGREANT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'segreant-config-atomic-'));
  process.env.SEGREANT_HOME = home;
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
    if (previousHome === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});


test('all Segreant config writers share one fail-closed mutation lock', () => {
  const previousHome = process.env.SEGREANT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'segreant-config-lock-'));
  process.env.SEGREANT_HOME = home;
  try {
    const first = structuredClone(DEFAULT_CONFIG);
    first.budget.dailyUsd = 10;
    saveConfig(first);

    const lock = acquireConfigMutationLock();
    try {
      const second = structuredClone(first);
      second.budget.dailyUsd = 20;
      assert.throws(
        () => saveConfig(second),
        /config.*(?:active|lock)|mutation.*active|stale lock/i,
        'a second Segreant writer must not overwrite a config while another writer owns the mutation generation',
      );
      saveConfigWithLock(second, lock);
      assert.equal(loadConfig().budget.dailyUsd, 20);
    } finally {
      lock.release();
    }

    const third = structuredClone(first);
    third.budget.dailyUsd = 30;
    saveConfig(third);
    assert.equal(loadConfig().budget.dailyUsd, 30, 'the config lock must be reusable after release');
  } finally {
    if (previousHome === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});


test('transactional config mutations compose from the latest generation', () => {
  const previousHome = process.env.SEGREANT_HOME;
  const home = mkdtempSync(join(tmpdir(), 'segreant-config-transaction-'));
  process.env.SEGREANT_HOME = home;
  try {
    const initial = structuredClone(DEFAULT_CONFIG);
    initial.budget.dailyUsd = 10;
    saveConfig(initial);

    mutateConfig((cfg) => {
      cfg.alerts.webhookUrl = 'https://example.test/hook';
    });
    const after = mutateConfig((cfg) => {
      cfg.budget.dailyUsd = 25;
    });

    assert.equal(after.alerts.webhookUrl, 'https://example.test/hook');
    assert.equal(after.budget.dailyUsd, 25);
    const disk = loadConfig();
    assert.equal(disk.alerts.webhookUrl, 'https://example.test/hook');
    assert.equal(disk.budget.dailyUsd, 25);
  } finally {
    if (previousHome === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('production read-modify-write paths cannot call saveConfig directly', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || path.endsWith(join('src', 'config.ts'))) continue;
      const source = readFileSync(path, 'utf8');
      if (/\bsaveConfig\s*\(/.test(source)) offenders.push(path.slice(src.length + 1).replaceAll('\\', '/'));
    }
  };
  walk(src);
  assert.deepEqual(
    offenders,
    [],
    'product config mutations must use mutateConfig() or an explicitly held saveConfigWithLock() generation',
  );
});

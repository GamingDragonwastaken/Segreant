/**
 * The running proxy follows budget edits made to config.json by another
 * process (the CLI, an editor), fails closed while the file is invalid, and
 * never lifts a cap because the file disappeared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveBudget } from '../src/proxy/server.ts';
import { DEFAULT_CONFIG, type SegreantConfig } from '../src/config.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  const file = join(dir, 'config.json');
  let stamp = Date.now() / 1000 - 100;
  let next: SegreantConfig | Error = structuredClone(DEFAULT_CONFIG);
  const write = (value: SegreantConfig | Error) => {
    next = value;
    writeFileSync(file, '{}');
    stamp += 10; // a distinct mtime per write, whatever the filesystem's resolution
    utimesSync(file, stamp, stamp);
  };
  writeFileSync(file, '{}');
  utimesSync(file, stamp, stamp);
  const config = structuredClone(DEFAULT_CONFIG);
  const budget = liveBudget(config, {
    intervalMs: 0,
    path: () => file,
    load: () => { if (next instanceof Error) throw next; return structuredClone(next); },
  });
  return { dir, file, config, budget, write };
}

test('a cap written to the file by another process governs the running proxy', () => {
  const { dir, budget, write } = setup();
  try {
    assert.equal(budget().dailyUsd, null);
    const capped = structuredClone(DEFAULT_CONFIG);
    capped.budget.dailyUsd = 5;
    write(capped);
    assert.equal(budget().dailyUsd, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid file fails closed until it is repaired, then enforcement resumes', () => {
  const { dir, budget, write } = setup();
  try {
    write(new Error('budget.dailyUsd must be null or a finite non-negative USD value'));
    assert.throws(() => budget(), /dailyUsd/);
    assert.throws(() => budget(), /dailyUsd/, 'still closed on the next request, not only the first');
    const repaired = structuredClone(DEFAULT_CONFIG);
    repaired.budget.dailyUsd = 2;
    write(repaired);
    assert.equal(budget().dailyUsd, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting config.json never lifts a cap that is in force', () => {
  const { dir, file, budget, write } = setup();
  try {
    const capped = structuredClone(DEFAULT_CONFIG);
    capped.budget.dailyUsd = 3;
    write(capped);
    assert.equal(budget().dailyUsd, 3);
    rmSync(file);
    assert.equal(budget().dailyUsd, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is not re-read faster than the interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}');
    let loads = 0;
    const budget = liveBudget(structuredClone(DEFAULT_CONFIG), {
      intervalMs: 60_000, path: () => file, load: () => { loads += 1; return structuredClone(DEFAULT_CONFIG); },
    });
    for (let i = 0; i < 100; i++) budget();
    assert.equal(loads, 0, 'an unchanged file is never re-parsed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

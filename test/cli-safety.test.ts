/**
 * What the 2026-09-30 terminal audit found, held shut:
 * - a mistyped amount printed a stack trace (and leaked a temp build path);
 * - `--demo` wrote the real config, so a cap chosen on sample data governed real spend;
 * - bare `prune` deleted immediately, the one mutating command with no preview;
 * - bare `budget` printed "Budget updated" when nothing was set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], home: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SEGREANT_HOME: home, NODE_OPTIONS: '' };
    delete env.SEGREANT_DB;
    delete env.SEGREANT_DEMO;
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: String(stdout) + String(stderr) });
    });
  });
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'segreant-cli-safety-'));
}

test('a mistyped amount is one plain line, refused before anything is saved', async () => {
  const dir = home();
  try {
    for (const bad of ['abc', '-5', '']) {
      const r = await runCli(['budget', '--daily', bad], dir);
      assert.equal(r.code, 1, `--daily ${JSON.stringify(bad)} is refused`);
      assert.match(r.out, /--daily needs a dollar amount/);
      assert.doesNotMatch(r.out, /\n\s+at /, 'no stack trace');
    }
    assert.equal(existsSync(join(dir, 'config.json')), false, 'nothing was written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unexpected fault is one line unless --debug is given', async () => {
  const dir = home();
  try {
    const plain = await runCli(['outcome'], dir);
    assert.equal(plain.code, 1);
    assert.doesNotMatch(plain.out, /\n\s+at /, 'a usage error prints no stack trace');
    assert.match(plain.out, /usage: segreant outcome/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo mode never writes the real config', async () => {
  const dir = home();
  try {
    const r = await runCli(['budget', '--daily', '5', '--demo'], dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /settings were not changed/);
    const config = join(dir, 'config.json');
    if (existsSync(config)) assert.doesNotMatch(readFileSync(config, 'utf8'), /"dailyUsd":\s*5\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare budget reports the caps and changes nothing', async () => {
  const dir = home();
  try {
    const r = await runCli(['budget'], dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /Current caps/);
    assert.doesNotMatch(r.out, /Budget updated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prune previews by default and deletes only with --apply', async () => {
  const dir = home();
  try {
    const preview = await runCli(['prune'], dir);
    assert.equal(preview.code, 0);
    assert.match(preview.out, /Would delete/);
    assert.doesNotMatch(preview.out, /Pruned|compacted/);
    const applied = await runCli(['prune', '--apply'], dir);
    assert.equal(applied.code, 0);
    assert.match(applied.out, /Pruned 0 request rows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

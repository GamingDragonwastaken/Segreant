import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestOption, trackFlags } from '../src/cli/flags.ts';

// H013/H014: an option no command read used to be dropped without a word, so
// `segreant budget --dayly 5` exited 0 having set nothing.

test('trackFlags reports only the options the command never read', () => {
  const tracked = trackFlags({ _: ['x'], daily: '5', dayly: '5', json: true });
  void tracked.flags.daily;
  void ('json' in tracked.flags);
  assert.deepEqual(tracked.unread(), ['dayly']);
});

test('suggestOption names a close option and stays quiet for a distant one', () => {
  assert.equal(suggestOption('dayly'), 'daily');
  assert.equal(suggestOption('aply'), 'apply');
  assert.equal(suggestOption('json'), 'json');
  assert.equal(suggestOption('zzzzzzzz'), null);
});

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, ['bin/segreant.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' },
  });
}

test('a mistyped option exits 2 with a suggestion and changes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-unread-'));
  try {
    const typo = run(home, ['budget', '--dayly', '5']);
    assert.equal(typo.status, 2, typo.stderr);
    assert.match(typo.stderr, /Unknown option --dayly .*Did you mean --daily\?/);

    const after = run(home, ['budget', '--json']);
    assert.equal(after.status, 0, after.stderr);
    const payload = JSON.parse(after.stdout) as { updated: boolean; budget: { dailyUsd: number | null } };
    assert.equal(payload.updated, false);
    assert.equal(payload.budget.dailyUsd, null, 'the typo set no cap');

    const help = run(home, ['help', '--json']);
    assert.equal(help.status, 2);
    assert.match(help.stderr, /--json does nothing for "segreant help"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor --json prints JSON with the pricing basis', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-doctor-'));
  try {
    const r = run(home, ['doctor', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout) as { pricing: { basis: { cohorts: unknown[] } }; proxy: { state: string } };
    assert.ok(Array.isArray(payload.pricing.basis.cohorts));
    assert.equal(typeof payload.proxy.state, 'string');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

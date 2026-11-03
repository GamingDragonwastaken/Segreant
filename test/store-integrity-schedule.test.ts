import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'seg-integrity-sched-'));
process.env.SEGREANT_HOME = home;
const { Store, integrityCheckDue, INTEGRITY_CHECK_INTERVAL_MS } = await import('../src/store/db.ts');

test.after(() => rmSync(home, { recursive: true, force: true }));

const DAY = INTEGRITY_CHECK_INTERVAL_MS;
const stamp = (path: string, body: string) => writeFileSync(path + '-integrity.json', body);

test('the full integrity pass is due without a stamp, and for an in-memory ledger', () => {
  const path = join(home, 'none.db');
  assert.equal(integrityCheckDue(path), true);
  assert.equal(integrityCheckDue(':memory:'), true);
});

test('a stamp younger than a day skips the pass; at a day it is due again', () => {
  const path = join(home, 'fresh.db');
  const now = 1_800_000_000_000;
  stamp(path, JSON.stringify({ checkedAtMs: now - DAY + 1 }));
  assert.equal(integrityCheckDue(path, now), false);
  stamp(path, JSON.stringify({ checkedAtMs: now - DAY }));
  assert.equal(integrityCheckDue(path, now), true);
});

test('a stamp that cannot be trusted makes the pass due, never skipped', () => {
  const path = join(home, 'bad.db');
  const now = 1_800_000_000_000;
  for (const body of ['not json', '{}', '{"checkedAtMs":"1800000000000"}', '{"checkedAtMs":null}', JSON.stringify({ checkedAtMs: now + 1 })]) {
    stamp(path, body);
    assert.equal(integrityCheckDue(path, now), true, body);
  }
});

test('opening a file ledger runs the pass once, stamps it, and the next open within a day skips it', () => {
  const path = join(home, 'ledger.db');
  new Store(path).close();
  assert.ok(existsSync(path + '-integrity.json'), 'the first open stamps a successful full pass');
  const first = JSON.parse(readFileSync(path + '-integrity.json', 'utf8')).checkedAtMs;
  assert.equal(integrityCheckDue(path), false);
  new Store(path).close();
  const second = JSON.parse(readFileSync(path + '-integrity.json', 'utf8')).checkedAtMs;
  assert.equal(second, first, 'an open within the interval neither runs nor re-stamps the full pass');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBudgetControlLock } from '../src/budget/controlLock.ts';

test('budget control lock serializes autonomous writers and is reusable after release', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-budget-control-lock-'));
  try {
    const first = acquireBudgetControlLock(home);
    assert.throws(() => acquireBudgetControlLock(home), /already active|stale lock/i);
    const record = JSON.parse(readFileSync(first.path, 'utf8')) as { token?: unknown; pid?: unknown };
    assert.equal(record.token, first.token);
    assert.equal(record.pid, process.pid);
    first.release();
    const second = acquireBudgetControlLock(home);
    second.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('budget control lock never deletes a generation whose token changed under it', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-budget-control-lock-token-'));
  try {
    const lock = acquireBudgetControlLock(home);
    writeFileSync(lock.path, JSON.stringify({ pid: 999999, token: 'different-owner' }) + '\n');
    lock.release();
    assert.equal(readFileSync(lock.path, 'utf8').includes('different-owner'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stale lock is fail-closed rather than time-stolen', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-budget-control-lock-stale-'));
  try {
    const path = join(home, 'budget-control.lock');
    writeFileSync(path, JSON.stringify({ pid: 2147483647, token: 'dead-but-not-stolen', startedAt: '2000-01-01T00:00:00.000Z' }) + '\n');
    assert.throws(() => acquireBudgetControlLock(home), /stale lock/i);
    assert.match(readFileSync(path, 'utf8'), /dead-but-not-stolen/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

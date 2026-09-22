import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RESOURCE_LIMITS, readBoundedUtf8File } from '../util/resource-limits.ts';

export interface BudgetControlLock {
  readonly path: string;
  readonly token: string;
  release(): void;
}

/**
 * Single-writer gate for the file-backed autonomous controller.
 *
 * Deliberately fail-closed: a stale lock is never stolen automatically. A crash
 * leaves an operator-visible artifact that must be reconciled/removed manually.
 * That is preferable to a timer granting two schedulers concurrent authority
 * over the same config/state/audit generation.
 */
export function acquireBudgetControlLock(home: string): BudgetControlLock {
  const path = join(home, 'budget-control.lock');
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error(`budget control is already active or left a stale lock at ${path}; refuse autonomous action until the operator reconciles it`);
    }
    throw error;
  }
  try {
    const body = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }) + '\n';
    writeSync(fd, body, undefined, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* preserve original error */ }
    try { unlinkSync(path); } catch { /* fail closed; stale artifact remains visible */ }
    throw error;
  }
  closeSync(fd);

  let released = false;
  return Object.freeze({
    path,
    token,
    release() {
      if (released) return;
      released = true;
      if (!existsSync(path)) return;
      let owner: unknown;
      try {
        owner = JSON.parse(readBoundedUtf8File(path, RESOURCE_LIMITS.budgetControlLockBytes, 'budget_control_lock_bytes'));
      } catch {
        // Do not delete a lock whose identity cannot be proven.
        return;
      }
      if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return;
      if ((owner as { token?: unknown }).token !== token) return;
      try { unlinkSync(path); } catch { /* stale owned lock is safer than deleting another generation */ }
    },
  });
}

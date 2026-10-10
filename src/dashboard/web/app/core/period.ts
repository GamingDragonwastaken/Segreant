/**
 * The one period the dashboard is looking at.
 *
 * The Metered view had its own range buttons while the four claims above it
 * stayed on 30 days, so choosing Today showed a $40 table under an $89 headline
 * with nothing to say the two covered different windows (H006). The period now
 * lives here: every claim and view that can be scoped by time reads it, and
 * every claim that cannot says its own scope instead.
 *
 * Remembered per browser, as a convenience only: storage can be absent or
 * blocked, so every read and write is guarded and the default is 30 days.
 */

import { signal } from './signal.ts';
import type { Range } from './api.ts';

const KEY = 'segreant.period';
const VALID: readonly Range[] = ['today', '7d', '30d', 'all'];

function stored(): Range {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return VALID.includes(v as Range) ? (v as Range) : '30d';
  } catch {
    return '30d';
  }
}

export const period = signal<Range>(stored());

export function setPeriod(r: Range): void {
  period.set(r);
  try {
    globalThis.localStorage?.setItem(KEY, r);
  } catch {
    // A blocked store only means the choice is not remembered.
  }
}

export { periodWords } from './periodWords.ts';

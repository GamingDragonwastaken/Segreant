/**
 * CLI argument parsing — the tiny, dependency-free flag grammar every command
 * shares: `--key value`, `--switch` (bare = true), positionals in `_`.
 * Extracted verbatim from cli.ts in the per-command-module split.
 */

import { startOfLocalDay } from '../budget/guard.ts';

export interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

/**
 * A mistake in what the user typed. The CLI prints its message as one line and
 * never a stack trace: the fix is in the command, not in Segreant.
 */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

/**
 * A dollar amount flag: a non-negative number, or `off`/`none` for no limit.
 * Anything else is refused before it can be saved.
 */
export function usdFlag(name: string, raw: string | boolean | string[]): number | null {
  const value = String(raw).trim();
  if (value === 'off' || value === 'none') return null;
  const amount = Number(value);
  if (raw === true || value === '' || !Number.isFinite(amount) || amount < 0) {
    throw new UserInputError(`--${name} needs a dollar amount, for example --${name} 20 (or --${name} off).`);
  }
  return amount;
}

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

export function rangeFor(window: 'today' | 'week' | 'month'): { startMs: number; endMs: number; label: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (window === 'today') return { startMs: startOfLocalDay(now), endMs: now + 1000, label: 'Today' };
  if (window === 'week') return { startMs: now - 7 * day, endMs: now + 1000, label: 'Last 7 days' };
  return { startMs: now - 30 * day, endMs: now + 1000, label: 'Last 30 days' };
}

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

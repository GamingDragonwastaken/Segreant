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

/**
 * Every option name some command reads, used ONLY to suggest a correction for
 * a mistyped one. It is not an allowlist: commands read options through
 * helpers and arrays a source scan cannot follow, so rejecting by this list
 * would refuse valid options.
 */
const KNOWN_OPTION_NAMES = [
  'account-ref', 'all', 'allow-unmetered', 'apply', 'archive', 'as-of', 'at', 'attempts', 'auto', 'category', 'centre',
  'clear', 'clear-webhook', 'close-status', 'commit', 'control', 'coverage', 'cwd', 'daily', 'dashboard-port', 'data-class',
  'days', 'debug', 'decision', 'deep', 'demo', 'detail', 'disabled', 'dry-run', 'economic', 'effective-at', 'every',
  'exact-money', 'file', 'finalize', 'format', 'from', 'grain', 'help', 'id', 'import-id', 'include-imported', 'into',
  'json', 'key', 'key-id', 'kind', 'labor-rate', 'limit', 'list', 'manifest', 'materiality', 'me', 'method', 'mode',
  'name', 'note', 'notify', 'notify-url', 'origin', 'out', 'owner', 'path-prefix', 'policy', 'port', 'priority',
  'project', 'project-ref', 'pubkey', 'purpose', 'rating', 'reason', 'recommend', 'reconcile', 'record-id', 'refresh',
  'reopen', 'repo', 'request', 'rescan', 'risk', 'root', 'runaway', 'scope', 'sensitivity', 'serve', 'session',
  'set-webhook', 'setup', 'sign', 'soft', 'start', 'target-currency', 'to', 'tool', 'trust', 'ts', 'tsf', 'unit',
  'until', 'url', 'use', 'verdict', 'verify', 'watch', 'window', 'wrap', 'write',
] as const;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length]!;
}

/** The closest known option name, when one is close enough to be the intended one. */
export function suggestOption(name: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const known of KNOWN_OPTION_NAMES) {
    const d = editDistance(name, known);
    if (d < bestD) { best = known; bestD = d; }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

/**
 * Wrap parsed flags so the options a command actually read are recorded.
 * `segreant budget --dayly 5` used to exit 0 having set nothing (H014), and a
 * command that ignores `--json` printed prose without saying so (H013). After
 * a command finishes, every option it never read is reported and the exit code
 * is 2. A mistyped `--apply` is therefore caught after the default preview,
 * which writes nothing.
 */
export function trackFlags(flags: Flags): { flags: Flags; unread: () => string[] } {
  const read = new Set<string>(['_']);
  const proxy = new Proxy(flags, {
    get(target, key, receiver) {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.has(target, key);
    },
  });
  return { flags: proxy, unread: () => Object.keys(flags).filter((k) => !read.has(k)) };
}

export function rangeFor(window: 'today' | 'week' | 'month'): { startMs: number; endMs: number; label: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (window === 'today') return { startMs: startOfLocalDay(now), endMs: now + 1000, label: 'Today' };
  if (window === 'week') return { startMs: now - 7 * day, endMs: now + 1000, label: 'Last 7 days' };
  return { startMs: now - 30 * day, endMs: now + 1000, label: 'Last 30 days' };
}

/**
 * Shared CLI presentation helpers — ANSI palette, money/number/percent
 * formatting, and the small disclosure lines every command reuses. Extracted
 * verbatim from cli.ts in the per-command-module split; the dispatcher and
 * every command module import from here so the CLI speaks with one voice.
 */

import type { Verdict } from '../value/gates.ts';

// Night Vault brand colors on terminals that declare 24-bit support (molten
// gold for value, sage for pass, signal red for alerts); the plain ANSI-16
// equivalents everywhere else so older terminals never see garbage escapes.
const truecolor =
  process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || Boolean(process.env.WT_SESSION);

export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: truecolor ? '\x1b[38;2;99;197;147m' : '\x1b[32m',
  yellow: truecolor ? '\x1b[38;2;232;179;60m' : '\x1b[33m',
  red: truecolor ? '\x1b[38;2;226;93;74m' : '\x1b[31m',
  gray: '\x1b[90m',
};

export function color(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${C.reset}` : s;
}

export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Actionable not-a-git-repo message: tell the user what to do, not just what's wrong. */
export function printNotAGitRepo(repo: string): void {
  console.error(`  Not a git repository: ${repo}`);
  console.error('  Run this from inside your repo, or pass --repo <path>. Session-scored usage needs no git: fiscus usage');
}

/**
 * One-line honesty notes about where the realized-value figures came from: a
 * stored snapshot vs a live repo, and — for a live repo — whether the dollars were
 * scoped to THIS project's own spend (the ledger is characterized by project:
 * native imports or tagged traffic) or fell back to the project-blind window sum
 * (untagged proxy). Discloses the basis so the number is never silently mixed.
 */
export function noteSource(tty: boolean, source: 'git' | 'store', projectScoped?: boolean): void {
  if (source === 'store') {
    console.log(color(tty, C.gray, '  ● stored realization snapshot — no live repo attached; figures are as of the last realize run.'));
    return;
  }
  if (projectScoped === true) {
    console.log(color(tty, C.gray, "  ● scoped to this project's own spend — ledger characterized by project (imports / tagged traffic)."));
  } else if (projectScoped === false) {
    console.log(color(tty, C.gray, '  ● project-blind window attribution — no project-tagged spend here. Import or tag sources to scope value per project.'));
  }
}

export function glyph(tty: boolean, v: Verdict): string {
  if (v === 'pass') return color(tty, C.green, '✓');
  if (v === 'fail') return color(tty, C.red, '✗');
  return color(tty, C.gray, '·');
}

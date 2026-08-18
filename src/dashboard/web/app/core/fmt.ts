/**
 * Formatting, and the register that governs it.
 *
 * Fiscus has two audiences on the same screens: someone who could use the CLI
 * but should not have to, and someone who will never open a terminal. That is
 * not a beginner mode and an expert mode — the DATA is identical. It is a
 * register: how precisely the same fact is stated.
 *
 *   plain    $89.66        "spent this month"
 *   precise  $89.66053895  "metered, local rate-card estimate"
 *
 * Rounding is display only. Every underlying figure stays integer microdollars.
 */

import { signal } from './signal.ts';

export type Register = 'plain' | 'precise';

const STORAGE_KEY = 'fiscus.register';

function initialRegister(): Register | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'plain' || stored === 'precise' ? stored : null;
  } catch {
    return null; // private mode, or storage disabled — first-run choice reappears
  }
}

/** null means the first run has not asked yet. */
export const register = signal<Register | null>(initialRegister());

export function setRegister(next: Register): void {
  register.set(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* not fatal: the choice simply does not persist */
  }
}

export function isPrecise(): boolean {
  return register() === 'precise';
}

/** Money from a decimal USD number, at the current register's precision. */
export function usd(value: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const precise = opts.precise ?? isPrecise();
  if (precise) {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    const whole = Math.floor(abs);
    const micros = Math.round((abs - whole) * 1_000_000);
    return `${sign}$${whole.toLocaleString('en-US')}.${String(micros).padStart(6, '0')}`;
  }
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

/** Money from exact integer microdollars — the ledger's native unit. */
export function usdFromMicros(micros: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (micros === null || micros === undefined) return '—';
  return usd(micros / 1_000_000, opts);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US');
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function dateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function date(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relative(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date(ms);
}

/**
 * Turn a provenance sentinel into words. Every figure in Fiscus carries the
 * basis it came from; a label the operator cannot read is not provenance, it is
 * a database value leaking onto a screen.
 */
const BASIS_WORDS: Record<string, { plain: string; precise: string }> = {
  client_declared: { plain: 'the tool told us', precise: 'client_declared — self-asserted header, unverified' },
  tool_log_inferred: { plain: 'read from a tool log', precise: 'tool_log_inferred — folder name from a transcript' },
  tool_log_repo_resolved: { plain: 'matched to a repository', precise: 'tool_log_repo_resolved — git working-tree root' },
  tool_log_fallback: { plain: 'a best guess', precise: 'tool_log_fallback — no repo, no declared label' },
  unattributed: { plain: 'no project attached', precise: 'unattributed — carries cost, carries no project' },
  synthetic_demo: { plain: 'demo data', precise: 'synthetic_demo — seeded, not observed' },
  legacy_unknown: { plain: 'recorded before we tracked this', precise: 'legacy_unknown — never backfilled by design' },
  provider_api_pull: { plain: 'pulled from the provider', precise: 'provider_api_pull — authorized Costs read' },
  operator_supplied_export: { plain: 'a file you exported', precise: 'operator_supplied_export — unverified by the provider' },
  local_list_price: { plain: 'estimated from a price list', precise: 'local_list_price — rate card, not a bill' },
};

export function basisWords(basis: string | null | undefined): string {
  if (!basis) return '—';
  const entry = BASIS_WORDS[basis];
  if (!entry) return basis;
  return isPrecise() ? entry.precise : entry.plain;
}

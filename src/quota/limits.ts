/**
 * The vendors' own usage meters, as their tools write them to local logs.
 *
 * Codex writes `rate_limits` on every token count: the percentage used of a
 * 5-hour and a weekly window, with each window's reset time. Claude Code writes
 * no percentage; when a limit is reached it writes the vendor's message
 * ("You've hit your session limit · resets 6:40pm (Africa/Cairo)") as an API
 * error line. Both are the VENDOR's meter. Segreant's own count is the ledger;
 * the quota view sets the two side by side and never treats either as the
 * other.
 *
 * Pure: parsing only, no I/O.
 */

export type QuotaKind =
  | 'codex_primary' // Codex's shorter window (5 hours today; the log states its length)
  | 'codex_secondary' // Codex's longer window (a week today)
  | 'claude_session' // Claude's 5-hour session limit
  | 'claude_weekly'
  | 'claude_spend' // Claude's monthly extra-usage spend limit
  | 'claude_other'
  // Claude Code's live meter, as it hands it to a status line script
  // (`segreant statusline`): percentages, like Codex's.
  | 'claude_five_hour'
  | 'claude_seven_day'
  | 'claude_spend_window';

export interface QuotaEvent {
  source: 'codex' | 'claude-code';
  kind: QuotaKind;
  tsEpochMs: number;
  /** The vendor's percentage used (Codex only). */
  usedPercent: number | null;
  windowMinutes: number | null;
  /** When the vendor says the window resets; null when the message gives no time. */
  resetsAtMs: number | null;
  /** The vendor's words, trimmed (Claude), for the person to check. */
  detail: string | null;
}

interface RateWindow { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }

/** Codex snapshots from one token_count payload's `rate_limits`. */
export function codexRateLimitEvents(rateLimits: unknown, tsEpochMs: number): QuotaEvent[] {
  if (rateLimits === null || typeof rateLimits !== 'object') return [];
  const out: QuotaEvent[] = [];
  for (const [key, kind] of [['primary', 'codex_primary'], ['secondary', 'codex_secondary']] as const) {
    const w = (rateLimits as Record<string, unknown>)[key] as RateWindow | null | undefined;
    if (w === null || w === undefined || typeof w !== 'object') continue;
    const used = typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) ? w.used_percent : null;
    if (used === null) continue;
    const minutes = typeof w.window_minutes === 'number' && w.window_minutes > 0 ? w.window_minutes : null;
    const resets = typeof w.resets_at === 'number' && w.resets_at > 0 ? w.resets_at * 1000 : null;
    out.push({ source: 'codex', kind, tsEpochMs, usedPercent: used, windowMinutes: minutes, resetsAtMs: resets, detail: null });
  }
  return out;
}

/**
 * The `rate_limits` object Claude Code passes to a status line script
 * (code.claude.com/docs/en/statusline): `five_hour`, `seven_day` and
 * `spend_limit`, each with `used_percentage` (0-100) and `resets_at` (epoch
 * seconds). Present for Pro and Max subscribers after a session's first
 * response; each window may be absent.
 */
export function claudeStatuslineEvents(input: unknown, tsEpochMs: number): QuotaEvent[] {
  if (input === null || typeof input !== 'object') return [];
  const limits = (input as { rate_limits?: unknown }).rate_limits;
  if (limits === null || typeof limits !== 'object') return [];
  const out: QuotaEvent[] = [];
  for (const [key, kind, minutes] of [
    ['five_hour', 'claude_five_hour', 300],
    ['seven_day', 'claude_seven_day', 10_080],
    ['spend_limit', 'claude_spend_window', null],
  ] as const) {
    const w = (limits as Record<string, unknown>)[key] as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    if (w === null || w === undefined || typeof w !== 'object') continue;
    const used = typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage) ? w.used_percentage : null;
    if (used === null) continue;
    const resets = typeof w.resets_at === 'number' && w.resets_at > 0 ? w.resets_at * 1000 : null;
    out.push({ source: 'claude-code', kind, tsEpochMs, usedPercent: used, windowMinutes: minutes, resetsAtMs: resets, detail: null });
  }
  return out;
}

const CLAUDE_LIMIT = /You've hit your ([a-z ]{3,30}?) limit(?: · resets ([0-9]{1,2}(?::[0-9]{2})?\s?[ap]m)(?: \(([A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2})\))?)?/;

/**
 * A Claude Code limit message, only from the vendor's own error line
 * (`"isApiErrorMessage":true`). The same words quoted in a prompt or a tool
 * result are not a limit event.
 */
export function claudeLimitEvent(line: string, tsEpochMs: number): QuotaEvent | null {
  if (!line.includes('"isApiErrorMessage":true')) return null;
  const m = CLAUDE_LIMIT.exec(line);
  if (m === null) return null;
  const what = m[1]!.trim();
  const kind: QuotaKind = what === 'session' ? 'claude_session'
    : what === 'weekly' ? 'claude_weekly'
      : what.includes('spend') ? 'claude_spend'
        : 'claude_other';
  const resetsAtMs = m[2] !== undefined ? nextLocalTime(m[2], m[3] ?? null, tsEpochMs) : null;
  return {
    source: 'claude-code',
    kind,
    tsEpochMs,
    usedPercent: null,
    windowMinutes: kind === 'claude_session' ? 300 : kind === 'claude_weekly' ? 10_080 : null,
    resetsAtMs,
    detail: m[0].slice(0, 120),
  };
}

/** Minutes a zone is ahead of UTC at an instant (Cairo in summer: +180). */
export function zoneOffsetMinutes(timeZone: string, atMs: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(atMs));
  } catch {
    return null; // an unknown zone name
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

/**
 * The first instant after `afterMs` at which the clock in `timeZone` reads
 * `clock` ("6:40pm", "4am"). With no zone, the machine's own zone is assumed,
 * which is the zone Claude Code itself printed in.
 */
export function nextLocalTime(clock: string, timeZone: string | null, afterMs: number): number | null {
  const m = /^([0-9]{1,2})(?::([0-9]{2}))?\s?([ap]m)$/.exec(clock.trim());
  if (m === null) return null;
  const clockHour = Number(m[1]);
  if (clockHour < 1 || clockHour > 12) return null; // a 12-hour clock reads 1 to 12
  let hour = clockHour % 12;
  if (m[3] === 'pm') hour += 12;
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const offsetAt = (ms: number): number | null => timeZone === null ? -new Date(ms).getTimezoneOffset() : zoneOffsetMinutes(timeZone, ms);
  const offset = offsetAt(afterMs);
  if (offset === null) return null;
  // The local calendar day of `afterMs`, then that day's clock time, in UTC.
  const local = new Date(afterMs + offset * 60_000);
  for (let day = 0; day <= 1; day++) {
    const wallAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute);
    const guess = wallAsUtc - offset * 60_000;
    // Re-read the offset at the guess so a DST change between the two instants is honoured.
    const exact = wallAsUtc - (offsetAt(guess) ?? offset) * 60_000;
    if (exact > afterMs) return exact;
  }
  return null;
}

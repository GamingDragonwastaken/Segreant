/**
 * The quota view: what each vendor's meter says, the pace to its reset, and
 * whether the vendor's percentage moves in step with what Segreant counted.
 *
 * Two kinds of claim, kept apart:
 *   - the vendor's meter (Codex's percentages, Claude's limit messages), read
 *     from the vendor's own tool logs;
 *   - Segreant's count, the list cost the ledger recorded over the same window.
 * A projection ("at this pace you hit 100% Thursday 14:00") is an estimate from
 * the vendor's percentage and elapsed time, and says so. A disagreement between
 * the meter and the count is shown as evidence, never as an accusation: the
 * vendor may weight models, cache or tools differently from list price.
 *
 * Pure: events and a spend reader in, a plain object out.
 */
import type { QuotaEvent, QuotaKind } from './limits.ts';

export interface WindowView {
  kind: QuotaKind;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAtMs: number | null;
  /** When the vendor last reported this window. */
  asOfMs: number;
  /** The window has reset since the vendor's last report: no current reading. */
  reset: boolean;
  /** Estimate: percentage at the reset if the pace since the window opened continues. */
  projectedAtResetPercent: number | null;
  /** Estimate: when 100% is reached at that pace, if before the reset. */
  limitAtMs: number | null;
}

export interface MeterCheck {
  /** List cost Segreant counted per 1% of the vendor's meter, this window. */
  currentUsdPerPercent: number | null;
  /** The same for earlier windows (newest first). */
  earlierUsdPerPercent: number[];
  /** Within the band of the earlier windows' median; null when there is too little to compare. */
  agrees: boolean | null;
}

export interface ClaudeLimitView {
  sessionHits: number;
  weeklyHits: number;
  spendHits: number;
  lastHit: QuotaEvent | null;
  /** List cost counted in the 5-hour window before each session-limit hit. */
  usdBeforeSessionHit: number[];
  /** List cost counted in the last 5 hours. */
  lastFiveHoursUsd: number;
}

export interface QuotaView {
  codex: { windows: WindowView[]; weekly: MeterCheck } | null;
  claude: ClaudeLimitView | null;
  /** Claude's live meter, when a `segreant statusline` has recorded it. */
  claudeWindows: WindowView[];
}

/** A reader for Segreant's own count: list cost of one source in [startMs, endMs). */
export type SpendReader = (source: 'codex' | 'claude-code', startMs: number, endMs: number) => number;

const AGREE_BAND = 1.5; // within 1.5x either way of the earlier median
const MIN_PERCENT_FOR_RATIO = 5; // a 1-2% reading is too coarse to divide by

export function windowView(e: QuotaEvent, nowMs: number): WindowView {
  const used = e.usedPercent ?? 0;
  const reset = e.resetsAtMs !== null && e.resetsAtMs <= nowMs;
  let projected: number | null = null;
  let limitAt: number | null = null;
  if (!reset && e.resetsAtMs !== null && e.windowMinutes !== null) {
    const opened = e.resetsAtMs - e.windowMinutes * 60_000;
    const elapsed = e.tsEpochMs - opened;
    if (elapsed > 0) {
      const perMs = used / elapsed;
      projected = used + perMs * (e.resetsAtMs - e.tsEpochMs);
      if (used >= 100) limitAt = e.tsEpochMs;
      else if (perMs > 0) {
        const at = e.tsEpochMs + (100 - used) / perMs;
        if (at < e.resetsAtMs) limitAt = at;
      }
    }
  }
  return {
    kind: e.kind, usedPercent: used, windowMinutes: e.windowMinutes, resetsAtMs: e.resetsAtMs,
    asOfMs: e.tsEpochMs, reset, projectedAtResetPercent: projected, limitAtMs: limitAt,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** For the longer Codex window: list cost per 1% of the vendor's meter, this window and earlier ones. */
export function meterCheck(events: QuotaEvent[], spend: SpendReader): MeterCheck {
  const byWindow = new Map<number, QuotaEvent>();
  for (const e of events) {
    if (e.kind !== 'codex_secondary' || e.resetsAtMs === null || e.windowMinutes === null) continue;
    const prev = byWindow.get(e.resetsAtMs);
    if (prev === undefined || e.tsEpochMs > prev.tsEpochMs) byWindow.set(e.resetsAtMs, e);
  }
  const ratios = [...byWindow.values()]
    .sort((a, b) => b.resetsAtMs! - a.resetsAtMs!)
    .map((e) => {
      if ((e.usedPercent ?? 0) < MIN_PERCENT_FOR_RATIO) return null;
      const opened = e.resetsAtMs! - e.windowMinutes! * 60_000;
      return spend('codex', opened, e.tsEpochMs + 1) / e.usedPercent!;
    });
  const current = ratios[0] ?? null;
  const earlier = ratios.slice(1, 9).filter((r): r is number => r !== null);
  const m = median(earlier);
  return {
    currentUsdPerPercent: current,
    earlierUsdPerPercent: earlier,
    agrees: current === null || m === null || earlier.length < 2 || m === 0
      ? null
      : current / m <= AGREE_BAND && m / current <= AGREE_BAND,
  };
}

export function claudeLimitView(events: QuotaEvent[], spend: SpendReader, nowMs: number): ClaudeLimitView | null {
  // Parallel agents hit the same wall together: one hit per window (its reset).
  const hits = new Map<string, QuotaEvent>();
  for (const e of events) {
    if (e.source !== 'claude-code') continue;
    const key = JSON.stringify([e.kind, e.resetsAtMs ?? Math.floor(e.tsEpochMs / 3_600_000)]);
    const prev = hits.get(key);
    if (prev === undefined || e.tsEpochMs < prev.tsEpochMs) hits.set(key, e);
  }
  const list = [...hits.values()].sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  const fiveHours = 5 * 60 * 60_000;
  const usdBeforeSessionHit = list
    .filter((e) => e.kind === 'claude_session')
    .map((e) => spend('claude-code', (e.resetsAtMs ?? e.tsEpochMs) - fiveHours, e.tsEpochMs + 1));
  const lastFiveHoursUsd = spend('claude-code', nowMs - fiveHours, nowMs + 1);
  if (list.length === 0 && lastFiveHoursUsd === 0) return null;
  return {
    sessionHits: list.filter((e) => e.kind === 'claude_session').length,
    weeklyHits: list.filter((e) => e.kind === 'claude_weekly').length,
    spendHits: list.filter((e) => e.kind === 'claude_spend').length,
    lastHit: list[list.length - 1] ?? null,
    usdBeforeSessionHit,
    lastFiveHoursUsd,
  };
}

export function quotaView(events: QuotaEvent[], spend: SpendReader, nowMs: number): QuotaView {
  const codexEvents = events.filter((e) => e.source === 'codex');
  const latest = new Map<QuotaKind, QuotaEvent>();
  for (const e of codexEvents) {
    const prev = latest.get(e.kind);
    if (prev === undefined || e.tsEpochMs >= prev.tsEpochMs) latest.set(e.kind, e);
  }
  const windows = (['codex_primary', 'codex_secondary'] as const)
    .map((k) => latest.get(k))
    .filter((e): e is QuotaEvent => e !== undefined)
    .map((e) => windowView(e, nowMs));
  const claudeLatest = new Map<QuotaKind, QuotaEvent>();
  for (const e of events) {
    if (e.kind !== 'claude_five_hour' && e.kind !== 'claude_seven_day' && e.kind !== 'claude_spend_window') continue;
    const prev = claudeLatest.get(e.kind);
    if (prev === undefined || e.tsEpochMs >= prev.tsEpochMs) claudeLatest.set(e.kind, e);
  }
  const claudeWindows = (['claude_five_hour', 'claude_seven_day', 'claude_spend_window'] as const)
    .map((k) => claudeLatest.get(k))
    .filter((e): e is QuotaEvent => e !== undefined)
    .map((e) => windowView(e, nowMs));
  return {
    codex: windows.length === 0 ? null : { windows, weekly: meterCheck(codexEvents, spend) },
    claude: claudeLimitView(events.filter((e) => !e.kind.startsWith('claude_') || e.usedPercent === null), spend, nowMs),
    claudeWindows,
  };
}

export { median };

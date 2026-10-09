/**
 * Claude Code's status line, the lean path.
 *
 * Claude Code runs the status line command on every refresh and pipes session
 * JSON on stdin; for Pro and Max subscribers that JSON carries the live usage
 * meter (`rate_limits`). Going through the full CLI took 1.6 s a call, almost
 * all of it opening the Store with its schema and integrity checks, which is
 * far too slow for a bar that refreshes on every message. This path opens the
 * ledger file directly, writes at most one row per meter (only when the
 * reading changed), sums today's list cost and prints one line.
 *
 * It must never break the person's status bar: any failure prints a minimal
 * line. It never creates the ledger or its tables; a fresh machine gets them
 * from the first ordinary `segreant` command, and until then the line still
 * prints.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { claudeStatuslineEvents } from './limits.ts';

export function statuslineLine(dbFile: string, rawInput: string, nowMs: number): string {
  let input: unknown = null;
  try { input = rawInput.trim() === '' ? null : JSON.parse(rawInput); } catch { input = null; }
  const events = claudeStatuslineEvents(input, nowMs);
  const parts = events
    .filter((e) => e.kind !== 'claude_spend_window')
    .map((e) => `${e.kind === 'claude_five_hour' ? '5h' : 'week'} ${Math.round(e.usedPercent ?? 0)}%`);
  if (!existsSync(dbFile)) return parts.length > 0 ? parts.join(' · ') : 'segreant';
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile);
    // A running import holds the write lock in short batches; wait briefly, never long.
    db.exec('PRAGMA busy_timeout = 200');
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quota_events'").get() !== undefined;
    if (hasTable) {
      const last = db.prepare(
        'SELECT used_percent AS used, resets_at_ms AS resets FROM quota_events WHERE source = ? AND kind = ? ORDER BY ts_epoch_ms DESC LIMIT 1',
      );
      const insert = db.prepare(
        `INSERT INTO quota_events (source, kind, ts_epoch_ms, used_percent, window_minutes, resets_at_ms, detail)
         VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(source, kind, ts_epoch_ms) DO NOTHING`,
      );
      for (const e of events) {
        const prev = last.get(e.source, e.kind) as { used: number | null; resets: number | null } | undefined;
        const resets = e.resetsAtMs === null ? null : Math.trunc(e.resetsAtMs);
        if (prev !== undefined && prev.used === e.usedPercent && prev.resets === resets) continue;
        insert.run(e.source, e.kind, Math.trunc(e.tsEpochMs), e.usedPercent, e.windowMinutes, resets);
      }
    }
    const dayStart = new Date(nowMs);
    dayStart.setHours(0, 0, 0, 0);
    const today = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM requests WHERE ts_epoch_ms >= ?').get(dayStart.getTime()) as { c: number } | undefined;
    if (today !== undefined) parts.push(`today $${today.c.toFixed(2)} list`);
  } catch {
    // A locked, missing or older ledger: show what the input alone gives.
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  return parts.length > 0 ? parts.join(' · ') : 'segreant';
}

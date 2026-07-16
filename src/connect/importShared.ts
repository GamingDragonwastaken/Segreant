/**
 * Shared core for every "import source" — the native-metering path.
 *
 * A proxy meters traffic it forwards. An IMPORTER meters traffic a tool already
 * wrote to local disk (transcripts, session DBs, rollout logs), so it works for
 * subscription/managed tools that never touch a proxy and need no base-URL
 * wiring. Every importer produces the same summary shape and accumulates rows
 * through this one helper, so the CLI and dashboard render them identically and
 * the honesty invariants (idempotent by request_id, estimated flagged) live in
 * exactly one place.
 */

import type { Store, RequestRow } from '../store/db.ts';

export interface ImportSummary {
  /** Containers scanned: JSONL files for transcript feeds, 1 for a session DB. */
  files: number;
  /** Distinct usage events found (after per-container dedupe). */
  eventsSeen: number;
  /** Rows actually inserted this run (new to the store — the incremental delta). */
  inserted: number;
  costUsd: number;
  /** Portion of costUsd priced by a fallback rather than an exact rate. */
  estimatedCostUsd: number;
  byModel: Record<string, { requests: number; costUsd: number }>;
  earliestMs: number | null;
  latestMs: number | null;
}

export function emptyImportSummary(files = 0): ImportSummary {
  return { files, eventsSeen: 0, inserted: 0, costUsd: 0, estimatedCostUsd: 0, byModel: {}, earliestMs: null, latestMs: null };
}

export interface ImportOptions {
  /** Override the source location (transcript root / DB path). */
  root?: string;
  /** Only import events at/after this epoch ms (default: everything). */
  sinceMs?: number;
  /** The `source` tag stored on each row (defaults per importer). */
  source?: string;
}

/**
 * Insert one already-built row idempotently and fold it into the summary if it
 * was new. `estimated` says whether its cost came from a fallback rate, so the
 * summary can report how much of the total is a best-effort estimate. Returns
 * true when the row was newly inserted.
 */
export function recordInsert(store: Store, summary: ImportSummary, row: RequestRow, estimated: boolean): boolean {
  summary.eventsSeen += 1;
  // Every imported row is stamped once here: sunk subscription cost, observed
  // after the fact — cap enforcement excludes it by default (budget.capIncludesImported).
  if (!store.insertRequestIfNew({ ...row, via: 'import' })) return false;
  summary.inserted += 1;
  summary.costUsd += row.costUsd;
  if (estimated) summary.estimatedCostUsd += row.costUsd;
  const m = (summary.byModel[row.model] ??= { requests: 0, costUsd: 0 });
  m.requests += 1;
  m.costUsd += row.costUsd;
  summary.earliestMs = summary.earliestMs === null ? row.tsEpochMs : Math.min(summary.earliestMs, row.tsEpochMs);
  summary.latestMs = summary.latestMs === null ? row.tsEpochMs : Math.max(summary.latestMs, row.tsEpochMs);
  return true;
}

/** The tools this build can import natively (for menus + the dashboard). */
export interface ImporterInfo {
  id: string;
  label: string;
  /** One line: what it reads and the honest scope. */
  blurb: string;
}

export const IMPORTERS: ImporterInfo[] = [
  { id: 'claude-code', label: 'Claude Code', blurb: 'Exact per-request usage from ~/.claude transcripts — works on Pro/Max subscriptions.' },
  { id: 'opencode', label: 'opencode', blurb: "Token usage from opencode's local session database (all providers it ran)." },
  { id: 'codex', label: 'Codex CLI', blurb: 'Per-turn token usage from ~/.codex rollout session logs.' },
];

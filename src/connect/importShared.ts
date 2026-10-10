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

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RequestObservationConflictError, type Store, type RequestRow } from '../store/db.ts';
import { repoToplevel } from '../git/correlate.ts';
import { projectKey, projectKeyWithBasis, type AttributionBasis } from '../value/characterization.ts';
import { RESOURCE_LIMITS, type CaptureCoverage } from '../util/resource-limits.ts';

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
  /**
   * Labels this run attributed to a repository root instead of the directory
   * basename the old rule would have used, as `basename → repo`. Rows already in
   * the ledger keep whatever label they were written with — the ledger is never
   * rewritten — so a non-empty list means the same work now appears under two
   * names until the operator aliases them. Reported for exactly that reason.
   */
  relabelled: Array<{ from: string; to: string }>;
  /** Optional source-input disclosure; absent means no input bound was hit. */
  captureCoverage?: CaptureCoverage;
  truncatedFiles?: number;
  truncatedLines?: number;
  truncatedRows?: number;
  /**
   * Rows whose request id was already recorded with a DIFFERENT charge. The
   * first record stands and these are left out; a non-zero count is disclosed
   * because it means two local logs disagree about one request.
   */
  conflictingObservations?: number;
  /** Files skipped because they have not changed since their last complete import. */
  filesUnchanged?: number;
  /** Files left for a later pass because they were last modified before `modifiedSinceMs`. */
  filesDeferred?: number;
}

export function emptyImportSummary(files = 0): ImportSummary {
  return {
    files, eventsSeen: 0, inserted: 0, costUsd: 0, estimatedCostUsd: 0, byModel: {},
    earliestMs: null, latestMs: null, relabelled: [],
  };
}

/**
 * Enumerate JSONL files a directory tree without asking Node to materialize the
 * entire recursive listing. Symlinks are intentionally not followed: native
 * tool logs are local files, and following a link could unexpectedly expose a
 * second tree. Once the file/directory budget is reached the caller receives a
 * sticky truncation disclosure instead of a silently partial import.
 */
export function boundedJsonlFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const pending = [root];
  let directories = 0;
  let truncated = false;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    directories += 1;
    if (directories > RESOURCE_LIMITS.importDirectories) {
      truncated = true;
      break;
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (directories + pending.length >= RESOURCE_LIMITS.importDirectories) {
          truncated = true;
          break;
        }
        pending.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (files.length >= RESOURCE_LIMITS.importFiles) {
        truncated = true;
        break;
      }
      try {
        if (statSync(full).isFile()) files.push(full);
      } catch {
        /* vanished mid-scan — skip */
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

/**
 * The version of what the importers read from a log file. A file read in full
 * by an older reader is read once more: version 2 added commit observations.
 */
export const IMPORT_READER_VERSION = 3;

/** A commit git reported creating, found in a line of an agent's log. */
export interface CommitObservationText {
  branch: string;
  shortSha: string;
  subject: string;
}

// git prints "[main 3f60dcf] subject" when it creates a commit, "[main
// (root-commit) 3f60dcf] subject" for the first one, and "[detached HEAD
// 3f60dcf] subject" off a branch. In a JSON log line the subject ends at an
// escaped newline or the closing quote of the string.
const COMMIT_LINE = /\[((?:detached HEAD)|[A-Za-z0-9._\/-]{1,120})(?: \(root-commit\))? ([0-9a-f]{7,40})\] ((?:[^"\\]|\\[^n]){1,200})/g;

/** Every commit-creation line in one raw (JSON-encoded) log line. */
export function commitObservationsInLine(line: string): CommitObservationText[] {
  if (!line.includes('] ')) return [];
  const found: CommitObservationText[] = [];
  for (const m of line.matchAll(COMMIT_LINE)) {
    let subject = m[3]!;
    try { subject = JSON.parse(`"${subject}"`) as string; } catch { /* keep the raw text */ }
    subject = subject.trim();
    if (subject.length === 0) continue;
    if (found.some((f) => f.shortSha === m[2])) continue;
    found.push({ branch: m[1]!, shortSha: m[2]!, subject });
  }
  return found;
}

/** A file's identity for the unchanged-file check. */
export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Decide whether a tool log file needs reading. Returns 'unchanged' when its
 * size and mtime match the last COMPLETE import of it into this ledger, its
 * stamp when it must be read, and null when it cannot be stat'ed (read it
 * anyway and record nothing). `rescan` always reads.
 */
export function fileStampForImport(
  store: Store, source: string, file: string, opts: ImportOptions,
): FileStamp | 'unchanged' | 'deferred' | null {
  let stamp: FileStamp;
  try {
    const st = statSync(file);
    stamp = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  } catch {
    return null;
  }
  if (opts.modifiedSinceMs !== undefined && stamp.mtimeMs < opts.modifiedSinceMs) return 'deferred';
  if (opts.rescan) return stamp;
  const last = store.importFileCursor(source, file);
  return last !== null && last.readerVersion === IMPORT_READER_VERSION && last.size === stamp.size && last.mtimeMs === stamp.mtimeMs
    ? 'unchanged'
    : stamp;
}

/**
 * Account for a skipped file: count it, and replay the truncation its last full
 * read recorded, so the summary discloses exactly what re-reading it would.
 */
export function noteFileUnchanged(store: Store, source: string, file: string, summary: ImportSummary): void {
  summary.filesUnchanged = (summary.filesUnchanged ?? 0) + 1;
  const last = store.importFileCursor(source, file);
  if (last === null) return;
  if (last.truncatedLines > 0) markImportTruncated(summary, 'lines', last.truncatedLines);
  if (last.truncatedRows > 0) markImportTruncated(summary, 'rows', last.truncatedRows);
}

/** The truncation counts recorded so far, to diff around one file's read. */
export interface TruncationMark {
  readonly lines: number;
  readonly rows: number;
}

export function truncationMark(summary: ImportSummary): TruncationMark {
  return { lines: summary.truncatedLines ?? 0, rows: summary.truncatedRows ?? 0 };
}

/**
 * Record a file as read in full, with the truncation that read saw. Nothing is
 * recorded for a --since read, which skipped rows on purpose.
 */
export function noteFileImported(
  store: Store, source: string, file: string, stamp: FileStamp | null,
  opts: ImportOptions, before: TruncationMark, summary: ImportSummary,
): void {
  if (stamp === null || (opts.sinceMs ?? 0) > 0) return;
  const now = truncationMark(summary);
  store.saveImportFileCursor(source, file, {
    size: stamp.size,
    mtimeMs: stamp.mtimeMs,
    truncatedLines: now.lines - before.lines,
    truncatedRows: now.rows - before.rows,
    readerVersion: IMPORT_READER_VERSION,
  });
}

/** Mark a source import as incomplete without changing its accounting rows. */
export function markImportTruncated(summary: ImportSummary, field: 'files' | 'lines' | 'rows', amount = 1): void {
  summary.captureCoverage = 'truncated';
  if (field === 'files') summary.truncatedFiles = (summary.truncatedFiles ?? 0) + amount;
  else if (field === 'lines') summary.truncatedLines = (summary.truncatedLines ?? 0) + amount;
  else summary.truncatedRows = (summary.truncatedRows ?? 0) + amount;
}

/** Record a basename → repo-root relabel once, for the operator-facing alias hint. */
export function noteRelabel(summary: ImportSummary, resolved: ResolvedAttribution): void {
  if (resolved.supersedes === null) return;
  if (summary.relabelled.some((r) => r.from === resolved.supersedes && r.to === resolved.project)) return;
  summary.relabelled.push({ from: resolved.supersedes, to: resolved.project });
}

export interface ImportOptions {
  /** Override the source location (transcript root / DB path). */
  root?: string;
  /** Only import events at/after this epoch ms (default: everything). */
  sinceMs?: number;
  /** The `source` tag stored on each row (defaults per importer). */
  source?: string;
  /** Read every file again, ignoring what earlier imports recorded. */
  rescan?: boolean;
  /**
   * Read only files modified at or after this time; leave the rest for a later
   * pass, with no cursor recorded, so that pass reads them. A log file's mtime
   * is at least the time of its last line, so every event at or after this time
   * is in a file this pass reads: the recent total is exact before the backfill.
   */
  modifiedSinceMs?: number;
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
  let inserted: boolean;
  try {
    inserted = store.insertRequestIfNew({ ...row, via: 'import' });
  } catch (err) {
    if (!(err instanceof RequestObservationConflictError)) throw err;
    summary.conflictingObservations = (summary.conflictingObservations ?? 0) + 1;
    return false;
  }
  if (!inserted) return false;
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

/** One resolved attribution, plus the basename it would have had without the repo lookup. */
export interface ResolvedAttribution {
  project: string;
  basis: AttributionBasis;
  /** The label the plain basename rule would have produced — non-null only when it DIFFERS. */
  supersedes: string | null;
}

/**
 * Resolve a tool-log working directory to the project it really belongs to.
 *
 * The basename rule alone gets two things wrong, both of which split or merge
 * real money:
 *
 *  - a session started in a SUBDIRECTORY (`~/code/app/packages/web`) labels the
 *    work `web`, so one repository's spend fragments across as many labels as
 *    there are directories anyone happened to `cd` into;
 *  - two unrelated repositories whose leaf directory has the same common name
 *    (`api`, `server`, `web`) merge into one project.
 *
 * Asking git for the working-tree root fixes both, and — more importantly — it
 * makes the label the SAME one `segreant realize` and `discoverProjectRepos`
 * compute for that repo, so imported spend and per-project RoI line up instead
 * of nearly lining up.
 *
 * When the path is not inside a repository (a scratch folder, a deleted
 * directory, no git on PATH), this degrades to exactly the previous behaviour
 * and says so through the basis. Results are cached per directory: a transcript
 * corpus has thousands of lines and a handful of distinct working directories.
 */
export function createRepoResolver(): (cwd: string | null | undefined, fallback: string) => Promise<ResolvedAttribution> {
  const cache = new Map<string, ResolvedAttribution>();
  return async (cwd, fallback) => {
    const inferred = projectKeyWithBasis(cwd, fallback);
    if (!cwd || inferred.basis === 'tool_log_fallback') return { ...inferred, supersedes: null };
    const key = `${cwd} ${fallback}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const top = await repoToplevel(cwd);
    const resolved: ResolvedAttribution =
      top === null
        ? { ...inferred, supersedes: null }
        : {
            project: projectKey(top, inferred.project),
            basis: 'tool_log_repo_resolved',
            supersedes: projectKey(top, inferred.project) === inferred.project ? null : inferred.project,
          };
    cache.set(key, resolved);
    return resolved;
  };
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
  { id: 'antigravity', label: 'Antigravity', blurb: 'Per-call token usage from the conversation databases Antigravity and the agy CLI keep under ~/.gemini.' },
];

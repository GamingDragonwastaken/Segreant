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
];

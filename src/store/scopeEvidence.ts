/**
 * The evidence a value snapshot's dollars were scoped by beyond its project
 * label: the agent sessions and the folders that verifiably made commits in the
 * repository (see git/repoScope.ts for how that evidence is accepted).
 *
 * A snapshot records the evidence its own window used (`unit.spendScope`), so a
 * later reprice re-sums exactly the same rows by exactly the same rule instead
 * of falling back to the label and quietly dropping the linked spend. Pure: no
 * git, no I/O, so the store layer can apply it.
 */
import { resolve } from 'node:path';

export interface ScopeEvidence {
  /** Sessions whose spend is counted wherever they ran. */
  sessions: string[];
  /** Folders whose spend is counted as a whole (moved checkouts, worktrees). */
  folders: string[];
}

/** The fields of a request row the evidence reads. */
export interface EvidenceRow {
  cwd?: string | null;
  sessionId: string | null;
}

/** Normalize a path for prefix comparison (Windows paths compare case-insensitively). */
export function normPath(p: string): string {
  const r = resolve(p).replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function pathUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/');
}

/** A matcher for rows the evidence covers (the label is checked by the caller). */
export function evidenceMatcher(ev: ScopeEvidence): (row: EvidenceRow) => boolean {
  const sessions = new Set(ev.sessions);
  const roots = ev.folders.map(normPath);
  return (row) => {
    if (row.sessionId !== null && sessions.has(row.sessionId)) return true;
    if (row.cwd) {
      const c = normPath(row.cwd);
      if (roots.some((root) => pathUnder(c, root))) return true;
    }
    return false;
  };
}

/** Read evidence back from a persisted snapshot; anything malformed is absent. */
export function parseScopeEvidence(value: unknown): ScopeEvidence | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as { sessions?: unknown; folders?: unknown };
  const strings = (x: unknown): string[] | null =>
    Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : null;
  const sessions = strings(v.sessions);
  const folders = strings(v.folders);
  if (sessions === null || folders === null) return undefined;
  if (sessions.length === 0 && folders.length === 0) return undefined;
  return { sessions, folders };
}

/** The `byModel` shape, grouped from already-scoped rows (same order: cost, descending). */
export function modelSpendFromRows(rows: ReadonlyArray<{
  provider: string; model: string; costUsd: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
}>): Array<{
  provider: string; label: string; costUsd: number; requests: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
}> {
  const groups = new Map<string, {
    provider: string; label: string; costUsd: number; requests: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number;
  }>();
  for (const r of rows) {
    const key = `${r.provider}\0${r.model}`;
    const g = groups.get(key) ?? {
      provider: r.provider, label: r.model, costUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    g.costUsd += r.costUsd;
    g.requests += 1;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.cacheReadTokens += r.cacheReadTokens;
    g.cacheWriteTokens += r.cacheWriteTokens;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd);
}

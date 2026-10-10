/**
 * Which recorded AI spend belongs to a repository.
 *
 * The plain rule is the project label: spend recorded while a tool ran inside
 * the repository's folder. That rule loses a repository's history as soon as it
 * moves (the old folder's label no longer matches), and it cannot see work done
 * from a git worktree or from a parent folder.
 *
 * This module adds what the agents' own logs PROVE. An agent session that
 * created a commit printed git's "[branch sha] subject" line, which the
 * importers record (observed_commits). An observation is accepted as evidence
 * for this repository only when all three hold:
 *
 *   1. the sha names a commit in this repository,
 *   2. the subject git printed starts the commit's subject (or the reverse), and
 *   3. the observation was logged within 30 minutes of the commit time.
 *
 * From the accepted observations two links follow:
 *
 *   - session: every request of a session that verifiably committed here
 *     belongs here, wherever the session was started;
 *   - folder: a folder a verified commit was made from belongs here when it no
 *     longer exists (a moved or deleted checkout) or is itself a checkout of
 *     this repository (a worktree). An existing folder that is not this
 *     repository (a parent folder, another repo) is never linked as a whole:
 *     only its verified sessions are.
 *
 * Nothing here is persisted and no ledger row is relabelled. The links are
 * recomputed from evidence on every run and reported beside the result.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Store, ObservedCommit } from '../store/db.ts';
import { evidenceMatcher, normPath as norm, pathUnder as under, type ScopeEvidence } from '../store/scopeEvidence.ts';
import { projectName } from './correlate.ts';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The fields of a request row this scope reads. */
export interface ScopedRow {
  project: string;
  projectCanonical?: string;
  cwd?: string | null;
  sessionId: string | null;
}

export interface LinkedFolder {
  path: string;
  /**
   * 'moved' = the folder no longer exists; 'worktree' = a worktree of this
   * repository; 'clone' = another checkout of the same repository (same root
   * commit), such as an agent's working copy whose work arrived by merge.
   */
  reason: 'moved' | 'worktree' | 'clone';
  verifiedCommits: number;
}

export interface RepoSpendScope {
  /** The repository's own label family (its label and any operator aliases). */
  readonly labels: ReadonlySet<string>;
  readonly linkedFolders: readonly LinkedFolder[];
  /** Sessions that verifiably made at least one commit in this repository. */
  readonly linkedSessions: ReadonlySet<string>;
  /** Accepted observations, and observations of other repos' (or no) commits. */
  readonly verifiedObservations: number;
  /** Whether evidence added anything beyond the label. */
  readonly extended: boolean;
  matches(row: ScopedRow): boolean;
  /**
   * The evidence that brought rows outside the label into scope, restricted
   * to what these rows used. Recorded in a value snapshot so a reprice can
   * re-sum the same rows; undefined when the label alone covered them.
   */
  evidenceFor(rows: readonly ScopedRow[]): ScopeEvidence | undefined;
}

const MAX_OBSERVATION_SKEW_MS = 30 * 60 * 1000;
const SUBJECT_PREFIX = 40;

/** True when the subject git printed and the commit's subject are the same subject. */
export function subjectsAgree(printed: string, actual: string): boolean {
  const a = printed.trim().replace(/\s+/g, ' ');
  const b = actual.trim().replace(/\s+/g, ' ');
  if (a.length === 0 || b.length === 0) return false;
  const n = Math.min(SUBJECT_PREFIX, b.length);
  return a.startsWith(b.slice(0, n)) || b.startsWith(a.slice(0, Math.min(SUBJECT_PREFIX, a.length)));
}

/**
 * A repository's identity: its root commit(s), the one thing every clone,
 * worktree and moved copy of it shares and no unrelated repository does. The
 * folder is not the identity (it moves) and the remote URL is not either (an
 * agent's working copy is often cloned from a local path).
 */
const identityCache = new Map<string, Promise<string | null>>();
export function repoIdentity(dir: string): Promise<string | null> {
  const key = norm(dir);
  let pending = identityCache.get(key);
  if (pending === undefined) {
    pending = git(dir, ['rev-list', '--max-parents=0', 'HEAD']).then(
      (out) => {
        const roots = out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
        return roots.length > 0 ? roots.join(',') : null;
      },
      () => null,
    );
    identityCache.set(key, pending);
  }
  return pending;
}

/**
 * A checkout's top level, spelled the way `dir` is spelled. `--show-toplevel`
 * returns the physical path (macOS adds /private, Windows expands 8.3 short
 * names), while ledger rows keep the spelling the agent logged; a linked folder
 * spelled differently would never match them. `--show-cdup` is relative, so
 * resolving it against `dir` keeps that spelling.
 */
async function topLevel(dir: string): Promise<string | null> {
  try {
    const up = (await git(dir, ['rev-parse', '--show-cdup'])).trim();
    return resolve(dir, up);
  } catch {
    return null;
  }
}

async function commonDir(dir: string): Promise<string | null> {
  try {
    const out = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return out === '' ? null : norm(out);
  } catch {
    return null;
  }
}

/**
 * Build the evidence-extended spend scope for one repository. `maxCommits`
 * bounds the history read to resolve observed shas (newest first).
 */
export async function repoSpendScope(
  store: Store,
  repoPath: string,
  opts: { maxCommits?: number; observations?: readonly ObservedCommit[] } = {},
): Promise<RepoSpendScope> {
  const label = await projectName(repoPath);
  const labels = new Set(store.projectFamily(label));
  // A caller scoping many repositories reads the observations once and passes them in.
  const observations = opts.observations ?? store.observedCommits();

  const linkedSessions = new Set<string>();
  const folderCounts = new Map<string, { path: string; count: number }>();
  let verifiedObservations = 0;

  if (observations.length > 0) {
    // One read of this repository's history: sha -> (time, subject).
    let log = '';
    try {
      log = await git(repoPath, ['log', '--all', `-n${opts.maxCommits ?? 20_000}`, '--format=%H%x1f%ct%x1f%s']);
    } catch {
      log = '';
    }
    const byPrefix = new Map<string, Array<{ hash: string; tsMs: number; subject: string }>>();
    for (const line of log.split('\n')) {
      const [hash, ct, subject] = line.split('\x1f');
      if (!hash || hash.length < 7 || ct === undefined || subject === undefined) continue;
      const key = hash.slice(0, 7);
      const list = byPrefix.get(key) ?? [];
      list.push({ hash, tsMs: Number(ct) * 1000, subject });
      byPrefix.set(key, list);
    }
    for (const o of observations) {
      const candidates = byPrefix.get(o.shortSha.slice(0, 7)) ?? [];
      const hit = candidates.find((c) => c.hash.startsWith(o.shortSha)
        && subjectsAgree(o.subject, c.subject)
        && Math.abs(o.tsEpochMs - c.tsMs) <= MAX_OBSERVATION_SKEW_MS);
      if (!hit) continue;
      verifiedObservations += 1;
      linkedSessions.add(o.sessionId);
      if (o.cwd) {
        const key = norm(o.cwd);
        const entry = folderCounts.get(key) ?? { path: o.cwd, count: 0 };
        entry.count += 1;
        folderCounts.set(key, entry);
      }
    }
  }

  // A folder is linked as a whole only when it is gone (moved or deleted) or is
  // a checkout of this very repository. Its own top level is what is linked.
  const repoCommon = await commonDir(repoPath);
  const repoId = await repoIdentity(repoPath);
  const repoRoot = norm(repoPath);
  const linkedFolders: LinkedFolder[] = [];
  for (const [key, entry] of folderCounts) {
    if (under(key, repoRoot)) continue; // already covered by the label
    if (!existsSync(entry.path)) {
      linkedFolders.push({ path: entry.path, reason: 'moved', verifiedCommits: entry.count });
      continue;
    }
    const common = await commonDir(entry.path);
    const reason = common !== null && repoCommon !== null && common === repoCommon
      ? 'worktree'
      : repoId !== null && (await repoIdentity(entry.path)) === repoId
        ? 'clone'
        : null;
    if (reason === null) continue;
    // The checkout's own top level is linked, so the rest of its work counts too.
    const top = (await topLevel(entry.path)) ?? entry.path;
    if (under(norm(top), repoRoot)) continue;
    const existing = linkedFolders.find((f) => norm(f.path) === norm(top));
    if (existing) existing.verifiedCommits += entry.count;
    else linkedFolders.push({ path: top, reason, verifiedCommits: entry.count });
  }
  const linked = evidenceMatcher({ sessions: [...linkedSessions], folders: linkedFolders.map((f) => f.path) });
  const labelled = (row: ScopedRow): boolean =>
    labels.has(row.projectCanonical ?? row.project) || labels.has(row.project);

  return {
    labels,
    linkedFolders,
    linkedSessions,
    verifiedObservations,
    extended: linkedFolders.length > 0 || linkedSessions.size > 0,
    matches(row: ScopedRow): boolean {
      return labelled(row) || linked(row);
    },
    evidenceFor(rows: readonly ScopedRow[]): ScopeEvidence | undefined {
      const sessions = new Set<string>();
      const folders = new Set<string>();
      for (const row of rows) {
        if (labelled(row)) continue;
        if (row.sessionId !== null && linkedSessions.has(row.sessionId)) sessions.add(row.sessionId);
        if (row.cwd) {
          const c = norm(row.cwd);
          for (const f of linkedFolders) if (under(c, norm(f.path))) folders.add(f.path);
        }
      }
      return sessions.size === 0 && folders.size === 0
        ? undefined
        : { sessions: [...sessions].sort(), folders: [...folders].sort() };
    },
  };
}

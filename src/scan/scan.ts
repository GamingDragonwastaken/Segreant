/**
 * System scan — the proactive, opt-in discovery pass.
 *
 * `import` and `discover` are REACTIVE: they meter tools you already pointed us at
 * and correlate repos we already captured a working directory for. `scan` is
 * PROACTIVE: it inspects the machine itself — which supported AI coding tools have
 * local usage data on disk, and which folders under a root you choose are git
 * repositories — and lays out a plan to set all of it up.
 *
 * It is read-only and local by construction: it reads file existence and directory
 * NAMES only, imports nothing, sends nothing, and mutates nothing. Turning the plan
 * into imported spend + per-project RoI is a separate, deliberate step
 * (`aegisflow scan --setup`, or the dashboard button). Every filesystem walk is
 * bounded (depth cap + visit budget + skip-list) so it can never wander the whole
 * disk or hang, and it never follows symlinks (no cycles, no escaping the roots).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store } from '../store/db.ts';
import { projectKey } from '../value/characterization.ts';
import { defaultClaudeCodeRoot } from '../connect/claudeCode.ts';
import { defaultOpencodeDbPath } from '../connect/opencode.ts';
import { defaultCodexRoot } from '../connect/codex.ts';

/** A supported AI coding tool and whether its local usage data is on this machine. */
export interface DetectedTool {
  id: string;
  label: string;
  present: boolean;
  /** Where its local usage data lives, if present — else null. */
  dataPath: string | null;
  /** One line: what we can read and the honest scope. */
  blurb: string;
}

/**
 * Detect which supported tools have local data here, reusing each importer's own
 * location resolver so there is ONE definition of "where does this tool store its
 * usage" — no third copy of the path logic. Read-only (existence checks only).
 */
export function detectTools(): DetectedTool[] {
  const claudeRoot = defaultClaudeCodeRoot(); // this resolver does not existence-check
  const claudePresent = existsSync(claudeRoot);
  const opencodeDb = defaultOpencodeDbPath(); // already null when absent
  const codexRoot = defaultCodexRoot(); // already null when absent
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      present: claudePresent,
      dataPath: claudePresent ? claudeRoot : null,
      blurb: 'Exact per-request usage from ~/.claude transcripts — works on Pro/Max subscriptions.',
    },
    {
      id: 'opencode',
      label: 'opencode',
      present: opencodeDb !== null,
      dataPath: opencodeDb,
      blurb: "Token usage from opencode's local session database (every provider it ran).",
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      present: codexRoot !== null,
      dataPath: codexRoot,
      blurb: 'Per-turn token usage from ~/.codex rollout session logs.',
    },
  ];
}

/** Directory names never worth descending into on a repo hunt (heavy or system). */
const HEAVY_DIRS: readonly string[] = [
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'bin', 'obj',
  'coverage', '__pycache__', 'venv', 'env',
  '$RECYCLE.BIN', 'AppData', 'Application Data', 'Library',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
];

export interface RepoScanOptions {
  /** How deep below each root to descend; the root itself is depth 0 (default 6). */
  maxDepth?: number;
  /** Hard budget on directories visited — bounds runtime on huge trees (default 20000). */
  maxDirs?: number;
  /** Extra directory names to never descend into, on top of the built-in heavy/system list. */
  skipNames?: string[];
}

export interface RepoScanResult {
  /** Absolute paths of directories that are git working trees (contain a `.git`). */
  repos: string[];
  /** The roots actually walked (nonexistent roots are dropped). */
  roots: string[];
  dirsVisited: number;
  /** True when the visit budget was hit — results are partial, scan a narrower root. */
  hitBudget: boolean;
}

/**
 * Walk the given roots for git repositories, bounded and read-only. A directory
 * that contains a `.git` entry is recorded as a repo, and the walk KEEPS descending:
 * a folder can be a git repo AND contain independent child repos (an umbrella repo,
 * a monorepo-of-repos, or a projects folder that was itself git-init'd — a real,
 * common case). The heavy/system skip-list already prunes node_modules / vendor /
 * venv, where nested `.git`s are almost always vendored dependencies, not projects.
 * Hidden dirs and symlinks are pruned (symlinks avoid cycles and root escapes);
 * unreadable dirs are skipped, never thrown. Iterative (an explicit stack) so deep
 * trees can't blow the call stack.
 */
export function findGitRepos(roots: string[], options: RepoScanOptions = {}): RepoScanResult {
  const maxDepth = options.maxDepth ?? 6;
  const maxDirs = options.maxDirs ?? 20000;
  const skip = new Set<string>([...HEAVY_DIRS, ...(options.skipNames ?? [])]);
  const repos: string[] = [];
  const walkedRoots: string[] = [];
  let dirsVisited = 0;
  let hitBudget = false;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    walkedRoots.push(root);
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
      if (dirsVisited >= maxDirs) {
        hitBudget = true;
        break;
      }
      const { dir, depth } = stack.pop()!;
      dirsVisited += 1;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, race, deleted) → skip, never throw
      }
      // A .git entry marks a repository root. Record it — but keep descending, so
      // independent child repos under an umbrella/init'd parent are not hidden.
      if (entries.some((e) => e.name === '.git')) {
        repos.push(dir);
      }
      if (depth >= maxDepth) continue;
      for (const e of entries) {
        // isDirectory() is false for symlinks (they report isSymbolicLink()), so
        // symlinked dirs are skipped — no cycles, no escaping the chosen roots.
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.')) continue; // hidden dirs aren't project roots; also prunes caches
        if (skip.has(e.name)) continue;
        stack.push({ dir: join(dir, e.name), depth: depth + 1 });
      }
    }
    if (hitBudget) break;
  }

  return { repos, roots: walkedRoots, dirsVisited, hitBudget };
}

export interface ScanPlan {
  tools: DetectedTool[];
  /** Roots actually walked for repos. */
  roots: string[];
  /** Every git repo found under the roots. */
  repos: string[];
  scan: RepoScanResult;
  /** Projects already in the ledger with a captured working directory. */
  knownProjects: number;
  /** Found repos that already have imported/proxied spend → RoI-ready right now. */
  reposWithSpend: string[];
  /** Found repos with no spend on record yet → an import would be needed to value them. */
  reposUnmetered: string[];
}

/**
 * Compose a dry-run plan: what tools are here, what repos exist under the roots, and
 * which of those repos the ledger can already value. A repo is "with spend" when its
 * project key already appears among the store's captured project paths — the same key
 * the correlation bridge uses, so the preview reflects exactly what `--setup` would do.
 * Pure over the store (a read of `projectPaths`) plus the read-only filesystem walk.
 */
export function planScan(store: Store, options: { roots?: string[]; scan?: RepoScanOptions } = {}): ScanPlan {
  const tools = detectTools();
  const roots = options.roots && options.roots.length > 0 ? options.roots : [homedir()];
  const scan = findGitRepos(roots, options.scan);

  const knownKeys = new Set(store.projectPaths().map((p) => projectKey(p.cwd)));
  const reposWithSpend: string[] = [];
  const reposUnmetered: string[] = [];
  for (const repo of scan.repos) {
    if (knownKeys.has(projectKey(repo))) reposWithSpend.push(repo);
    else reposUnmetered.push(repo);
  }

  return {
    tools,
    roots: scan.roots,
    repos: scan.repos,
    scan,
    knownProjects: knownKeys.size,
    reposWithSpend,
    reposUnmetered,
  };
}

/** Stable key identifying WHICH roots a snapshot covers — diffs only compare like-for-like. */
function rootsKeyOf(plan: ScanPlan): string {
  return plan.roots.join('|');
}

/** The persisted shape of a past scan, so a later scan can report what changed. */
export interface ScanSnapshot {
  rootsKey: string;
  repos: string[];
  /** Tool ids that were PRESENT at snapshot time. */
  toolIds: string[];
  atMs: number;
}

/** What changed since the last scan of the same roots. */
export interface ScanDiff {
  /** True only when a prior snapshot of the SAME roots existed to compare against. */
  comparable: boolean;
  /** When the compared-against scan ran, or null on a first (incomparable) scan. */
  sinceMs: number | null;
  newRepos: string[];
  /** Repos seen last time but gone now (deleted, moved, or un-git'd). */
  goneRepos: string[];
  /** Tool ids newly present since last scan. */
  newTools: string[];
}

/** Build the snapshot to persist for this plan (present tools + all repos found). */
export function snapshotFromPlan(plan: ScanPlan): ScanSnapshot {
  return {
    rootsKey: rootsKeyOf(plan),
    repos: [...plan.repos],
    toolIds: plan.tools.filter((t) => t.present).map((t) => t.id),
    atMs: Date.now(),
  };
}

/**
 * Diff the current plan against the previous snapshot — but ONLY when that snapshot
 * covers the same roots (otherwise "new repos" would just be a different folder's
 * contents, not real change). Pure: no I/O, so the change logic is testable to the line.
 */
export function diffScan(prev: ScanSnapshot | null, plan: ScanPlan): ScanDiff {
  if (!prev || prev.rootsKey !== rootsKeyOf(plan)) {
    return { comparable: false, sinceMs: null, newRepos: [], goneRepos: [], newTools: [] };
  }
  const prevRepos = new Set(prev.repos);
  const curRepos = new Set(plan.repos);
  const prevTools = new Set(prev.toolIds);
  const curTools = plan.tools.filter((t) => t.present).map((t) => t.id);
  return {
    comparable: true,
    sinceMs: prev.atMs,
    newRepos: plan.repos.filter((r) => !prevRepos.has(r)),
    goneRepos: prev.repos.filter((r) => !curRepos.has(r)),
    newTools: curTools.filter((id) => !prevTools.has(id)),
  };
}

/**
 * Compose a plan AND the diff against the last scan of the same roots. Read-only over
 * the store (a `projectPaths` read + a snapshot read); the caller decides when to
 * persist the new snapshot (via `saveScan`) so a pure preview can stay non-writing.
 */
export function scanWithDiff(store: Store, options: { roots?: string[]; scan?: RepoScanOptions } = {}): { plan: ScanPlan; diff: ScanDiff } {
  const plan = planScan(store, options);
  const prevRow = store.loadScanSnapshot(rootsKeyOf(plan));
  const prev: ScanSnapshot | null = prevRow ? { rootsKey: rootsKeyOf(plan), ...prevRow } : null;
  return { plan, diff: diffScan(prev, plan) };
}

/** Persist this plan as the new "last scan" for its roots (so the next scan can diff). */
export function saveScan(store: Store, plan: ScanPlan): void {
  const snap = snapshotFromPlan(plan);
  store.saveScanSnapshot(snap.rootsKey, snap.repos, snap.toolIds, snap.atMs);
}

/**
 * Characterization — the canonical vocabulary for the axes Fiscus slices usage
 * by, defined ONCE so every surface agrees on what a slice means.
 *
 * Metering answers "how much"; characterization answers "of what" — per project,
 * per model, per tool (source), per developer (user), per session. Before this
 * module the notion of a "project" was reimplemented in four places (each
 * importer's `basename(cwd)` and git's `basename(toplevel)`); a single drifting
 * definition there would silently split one project into two on a dashboard. So
 * the project key — the primary, most reliable, most RoI-relevant axis — lives
 * here as one function, shared by the importers (which read a working directory
 * from a transcript) AND the git correlator (which reads the repo top-level). When
 * a tool runs from its repo root, cwd basename == toplevel basename, so imported
 * spend and shipped commits characterize to the SAME project — which is exactly
 * what makes native, no-proxy per-project RoI possible.
 *
 * Pure and dependency-free (no store, no node built-ins beyond string ops) so it
 * can be imported anywhere — importers, correlation, the store, the API — without
 * a cycle. The aggregate `Characterization` SHAPE (which references SpendBucket)
 * lives in the store; this module owns only the axis vocabulary and the keys.
 */

/**
 * The axes usage is characterized by. `project`/`model`/`source`/`user` are flat
 * spend breakdowns (uniform buckets); `session` is a finer per-thread drill-down
 * with its own shape, served separately. Ordered most- to least-recommended as a
 * primary lens: project is the reliable, RoI-relevant axis; session is coarse for
 * tools that reuse one id across weeks (e.g. Claude Code), so it drills, not leads.
 */
export type Dimension = 'project' | 'source' | 'model' | 'user' | 'session';

export const DIMENSIONS: readonly Dimension[] = ['project', 'source', 'model', 'user', 'session'] as const;

export function isDimension(x: string): x is Dimension {
  return (DIMENSIONS as readonly string[]).includes(x);
}

/**
 * The one definition of a project key: the trailing path segment of a working
 * directory, split on either separator so a Windows path (`C:\a\game`) and a
 * POSIX path (`/home/a/game`) both characterize to `game`. A blank/rootless path
 * falls back to the caller's label (each importer names its own: 'claude-code',
 * 'opencode', 'codex'; the proxy/git default is 'default'), never to an empty key.
 *
 * Deliberately NOT case-folded: it must round-trip a real folder name, and the
 * importers + git already preserve case — folding here would fabricate a mismatch
 * on case-sensitive filesystems where `Api` and `api` are genuinely two projects.
 */
export function projectKey(dir: string | null | undefined, fallback = 'default'): string {
  if (!dir) return fallback;
  const base = dir
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return base && base.trim() ? base.trim() : fallback;
}

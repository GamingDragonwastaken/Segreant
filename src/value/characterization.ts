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

/**
 * `projectKey`, plus how the key was arrived at — for importers, which read a
 * working directory out of a tool's own local log.
 *
 * Kept beside `projectKey` so the two can never disagree: the basis is decided by
 * the same emptiness test that chooses the fallback. A caller that computed the
 * key here and the basis somewhere else would eventually drift.
 */
export function projectKeyWithBasis(
  dir: string | null | undefined,
  fallback: string,
): { project: string; basis: AttributionBasis } {
  const project = projectKey(dir, fallback);
  // Probe with an empty fallback: only a genuinely unusable path yields ''. This
  // matters because a real directory can legitimately be named after its tool —
  // `/home/me/codex` infers `codex`, which must NOT read as a fallback.
  //
  // The fallback label is the tool's own name: a placeholder, not a project the
  // operator named. Saying so is the difference between "work in repo `codex`"
  // and "Codex logged work but never recorded where".
  const usable = projectKey(dir, '') !== '';
  return { project, basis: usable ? 'tool_log_inferred' : 'tool_log_fallback' };
}

/**
 * How a row's `project` label was obtained — the attribution counterpart to the
 * ledger's pricing lineage (`cost_basis`, `rate_match_kind`) and route-scope
 * lineage (`scope_capture_status`).
 *
 * Money is reported per project, so "which project did this cost belong to" is a
 * financial claim, and it was previously unfalsifiable: a header a client set
 * itself, a folder basename, and a row that carried no signal at all were stored
 * in one indistinguishable TEXT column. In particular an untagged proxy request
 * is stored under the literal label `default`, which cannot be told apart from a
 * project someone genuinely named `default`.
 *
 * This records the basis WITHOUT changing the stored label, so no total moves —
 * the same dollars roll up the same way, but a reader can now ask what the
 * attribution rests on.
 *
 * **None of these values is an identity verification.** `client_declared` is a
 * self-assertion by whatever process set the header; anything on this machine
 * that can reach the proxy can set it. Chargeback-grade attribution would need a
 * verified collector identity, which Fiscus does not have. See the roadmap's
 * Stage 2: client-supplied headers "are not trusted alone for chargeback".
 */
export type AttributionBasis =
  /** An explicit `x-aegis-project` header on a proxied request. Self-asserted, unverified. */
  | 'client_declared'
  /**
   * The tool recorded a working directory, and that directory resolved to a git
   * repository on this machine — so the label is the repository's own root name,
   * not a guess from a path component. This is the strongest attribution an
   * importer can produce: it survives sessions started in a subdirectory, and it
   * matches the label `fiscus realize` computes for the same repo.
   *
   * The one thing it cannot check is time: the path is resolved against the
   * filesystem as it stands now, so a directory that has since been replaced by a
   * different repository would resolve to the new one.
   */
  | 'tool_log_repo_resolved'
  /** Derived from a working-directory path the tool recorded in its own local log. */
  | 'tool_log_inferred'
  /** The tool recorded no usable path, so its own name was used as the label. Not a real project. */
  | 'tool_log_fallback'
  /** Proxied traffic that declared no project. Stored under the default label, but it is not one. */
  | 'unattributed'
  /** Seeded demo data. Never a real attribution. */
  | 'synthetic_demo'
  /** Recorded before attribution basis existed. Genuinely unknown; never assume it was declared. */
  | 'legacy_unknown';

export const ATTRIBUTION_BASES: readonly AttributionBasis[] = [
  'client_declared', 'tool_log_repo_resolved', 'tool_log_inferred', 'tool_log_fallback',
  'unattributed', 'synthetic_demo', 'legacy_unknown',
] as const;

/**
 * True when the basis reflects a deliberate attribution act by the operator or
 * their tooling, rather than a fallback, a demo, or an absence. Deliberately NOT
 * called "trusted": a declared label is still unverified.
 */
export function isDeclaredAttribution(basis: AttributionBasis): boolean {
  return basis === 'client_declared' || basis === 'tool_log_repo_resolved' || basis === 'tool_log_inferred';
}

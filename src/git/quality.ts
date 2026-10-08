/**
 * Git-derived artifact persistence observations.
 *
 * This module measures whether a counted subset of lines introduced by a Git
 * commit is still attributed to that commit at the repository's current HEAD.
 * It is a local, deterministic observation of artifact retention. It is not a
 * measurement of semantic correctness, maintainability, business value, code
 * quality, or AI/human contribution.
 *
 * The older `CommitQuality`/`QualityReport` names and their scalar fields remain
 * at the compatibility edge. New consumers should read the typed
 * `artifactPersistence` construct and its measurement model instead.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store/db.ts';
import { attributeCommits, type CommitAttribution } from './correlate.ts';
import { measurementModel, type MeasurementModel } from '../measurement/model.ts';
import { scope } from '../epistemic/scope.ts';

const run = promisify(execFile);

/** The construct measured by Git line retention. */
export const ARTIFACT_PERSISTENCE_CONSTRUCT = 'artifact_persistence' as const;
export type ArtifactPersistenceConstruct = typeof ARTIFACT_PERSISTENCE_CONSTRUCT;

/** Constructs that Git line retention is explicitly forbidden to establish. */
export const ARTIFACT_PERSISTENCE_NON_CLAIMS = Object.freeze([
  'semantic correctness',
  'maintainability',
  'business value',
  'code quality',
  'AI or human contribution',
] as const);

export type ArtifactPersistenceNonClaim = (typeof ARTIFACT_PERSISTENCE_NON_CLAIMS)[number];

/**
 * The typed relationship between the Git observable and the construct it may
 * support. Keeping this beside the generic MeasurementModel prevents a caller
 * from reading `proxy_unvalidated` as if it meant "quality, but cautiously".
 */
export interface ArtifactPersistenceProxyRelationship {
  readonly kind: 'proxy';
  readonly observable: 'git blame line attribution';
  readonly targetConstruct: ArtifactPersistenceConstruct;
  readonly validation: 'proxy_unvalidated';
  readonly doesNotEstablish: readonly ArtifactPersistenceNonClaim[];
}

export interface ArtifactPersistenceMeasurementModel extends MeasurementModel {
  readonly proxyRelationship: ArtifactPersistenceProxyRelationship;
}

/**
 * The single measurement definition for this module. The generic model names
 * the target construct; the relationship adds the non-escalation boundary that
 * generic measurement metadata cannot infer from a precise line count.
 */
export const ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL: ArtifactPersistenceMeasurementModel = Object.freeze({
  ...measurementModel({
    id: 'git-artifact-persistence-v1',
    targetConstruct: ARTIFACT_PERSISTENCE_CONSTRUCT,
    measurand: 'introduced artifact lines retained at the current repository HEAD',
    observable: 'git blame line attribution',
    procedure: 'count current line records attributed to the source commit for files it changed',
    scope: scope({ domain: 'git', artifact: 'repository' }),
    population: 'selected Git commits in the declared repository window',
    validation: 'proxy_unvalidated',
    calibration: null,
    uncertainty: {
      kind: 'bounded',
      description: 'Line identity is an observable retention proxy; it does not identify the meaning or source of the retained artifact.',
      bound: 'retained lines are exact only for the files and blame history actually measured',
    },
  }),
  proxyRelationship: Object.freeze({
    kind: 'proxy' as const,
    observable: 'git blame line attribution' as const,
    targetConstruct: ARTIFACT_PERSISTENCE_CONSTRUCT,
    validation: 'proxy_unvalidated' as const,
    doesNotEstablish: ARTIFACT_PERSISTENCE_NON_CLAIMS,
  }),
});

/** Literal claim language permitted for an artifact-persistence observation. */
export const ARTIFACT_PERSISTENCE_CLAIM =
  'This subset of introduced artifact lines remains in the current repository after the declared maturity window.';

export interface ArtifactPersistenceInput {
  readonly introducedLines: number;
  readonly retainedLines: number;
  readonly measured: boolean;
}

/**
 * A typed artifact-persistence observation. When `measured` is false,
 * `retainedLines` is only the measured floor and `retentionRatio` is withheld.
 */
export interface ArtifactPersistence {
  readonly construct: ArtifactPersistenceConstruct;
  readonly introducedLines: number;
  readonly retainedLines: number;
  readonly retentionRatio: number | null;
  readonly measured: boolean;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`artifact persistence ${label} must be a non-negative safe integer`);
  return value;
}

/** Construct an artifact-persistence observation without adding quality meaning. */
export function artifactPersistence(input: ArtifactPersistenceInput): ArtifactPersistence {
  const introducedLines = nonNegativeInteger(input.introducedLines, 'introducedLines');
  const retainedLines = nonNegativeInteger(input.retainedLines, 'retainedLines');
  if (retainedLines > introducedLines) throw new Error('artifact persistence retainedLines cannot exceed introducedLines');
  if (typeof input.measured !== 'boolean') throw new Error('artifact persistence measured must be boolean');
  return Object.freeze({
    construct: ARTIFACT_PERSISTENCE_CONSTRUCT,
    introducedLines,
    retainedLines,
    retentionRatio: input.measured ? (introducedLines > 0 ? retainedLines / introducedLines : 0) : null,
    measured: input.measured,
  });
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A commit's numstat never changes, so it is read once per process. */
const commitFilesCache = new Map<string, Promise<Array<{ path: string; added: number }>>>();

/** Files a commit touched, with lines added per file (numstat). */
function commitFiles(repoPath: string, hash: string): Promise<Array<{ path: string; added: number }>> {
  const key = `${repoPath}\0${hash}`;
  let pending = commitFilesCache.get(key);
  if (pending === undefined) {
    if (commitFilesCache.size >= BLAME_CACHE_MAX) commitFilesCache.clear();
    pending = readCommitFiles(repoPath, hash);
    // A failed read is not cached: the next caller retries rather than inheriting it.
    pending.catch(() => commitFilesCache.delete(key));
    commitFilesCache.set(key, pending);
  }
  return pending;
}

async function readCommitFiles(repoPath: string, hash: string): Promise<Array<{ path: string; added: number }>> {
  // --format= suppresses the commit header; --numstat gives "added<TAB>deleted<TAB>path".
  const out = await git(repoPath, ['show', '--numstat', '--format=', hash]);
  const files: Array<{ path: string; added: number }> = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const added = m[1] === '-' ? 0 : Number(m[1]);
    files.push({ path: m[3]!, added });
  }
  return files;
}

/** Lines at a given HEAD attributed to each commit, for one file. */
type BlameCounts = ReadonlyMap<string, number>;

/**
 * Blame results keyed by repository, the HEAD commit they were taken at, and
 * the file. One blame of a file at HEAD already says how many of its lines
 * belong to EVERY commit, so a repository with forty commits touching the same
 * file needs one `git blame`, not forty. Measured on a 21-repository machine,
 * the per-commit blames were 85% of a 367-second correlation, spent idle while
 * one git process after another started.
 *
 * Keying by the HEAD commit (never the symbolic name) keeps a long-lived
 * dashboard process correct after a new commit: a new HEAD is a new key. The
 * map is bounded and cleared wholesale when full; a miss only costs a blame.
 */
const blameCache = new Map<string, Promise<BlameCounts | null>>();
const BLAME_CACHE_MAX = 4096;

/** Exposed for tests: forget every cached blame and numstat. */
export function clearBlameCache(): void {
  blameCache.clear();
  commitFilesCache.clear();
}

/**
 * Warm the numstat and blame caches for many commits at once, with up to
 * `concurrency` git processes running. Callers then measure commit by commit
 * exactly as before and find the answers waiting: this changes how long a
 * survival scan takes, never what it reports. Work is not STARTED after
 * `deadlineMs`; whether a commit counts as measured is still decided by the
 * caller's own deadline check, so a prefetch can never turn an unmeasured
 * commit into a measured one.
 */
export async function prefetchSurvival(
  repoPath: string,
  hashes: readonly string[],
  deadlineMs?: number,
  concurrency = 8,
  /** The same history bound the measuring pass will use, so the caches meet. */
  sinceSec?: number,
): Promise<void> {
  const expired = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  const pool = async <T>(items: readonly T[], work: (item: T) => Promise<unknown>) => {
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (next < items.length && !expired()) {
        const item = items[next++]!;
        try { await work(item); } catch { /* the measuring pass will see and report it */ }
      }
    });
    await Promise.all(lanes);
  };
  const head = await headCommit(repoPath);
  if (head === null) return;
  const paths = new Set<string>();
  await pool(hashes, async (hash) => {
    for (const f of await commitFiles(repoPath, hash)) if (f.added > 0) paths.add(f.path);
  });
  await pool([...paths], (path) => blameAt(repoPath, head, path, sinceSec));
}

async function headCommit(repoPath: string): Promise<string | null> {
  try {
    const out = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git blame --porcelain` into lines per commit. Every source line gets a
 * header line `<sha> <orig-line> <final-line>[ <group-size>]`; commit metadata
 * (author, summary, `previous`, `boundary`, ...) never starts with a hex
 * object name followed by two numbers, and content lines start with a tab.
 */
export function blameCountsFromPorcelain(out: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,64}) \d+ \d+(?: \d+)?\r?$/.exec(line);
    if (!m) continue;
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

/**
 * `sinceSec` bounds blame's walk back through history. Every commit newer than
 * it keeps its exact line count; lines from older history are credited to a
 * boundary commit instead of being traced to their origin, which is where
 * almost all of blame's time goes on a long-lived file. Callers pass a bound
 * older than every commit they measure, so their counts are unchanged.
 */
function blameAt(repoPath: string, head: string, path: string, sinceSec?: number): Promise<BlameCounts | null> {
  const key = `${repoPath}\0${head}\0${path}\0${sinceSec ?? ''}`;
  let pending = blameCache.get(key);
  if (pending === undefined) {
    if (blameCache.size >= BLAME_CACHE_MAX) blameCache.clear();
    const bound = sinceSec === undefined ? [] : [`--since=${sinceSec}`];
    pending = git(repoPath, ['blame', '--porcelain', ...bound, head, '--', path]).then(
      blameCountsFromPorcelain,
      () => null, // file deleted/renamed at HEAD
    );
    blameCache.set(key, pending);
  }
  return pending;
}

/**
 * Count how many lines currently in the file (at `head`) remain attributed to
 * `hash` by git blame. This is the retained-line count for `hash`'s introduced
 * artifact lines; it is not a quality score.
 */
async function survivingLinesInFile(repoPath: string, head: string, hash: string, path: string, sinceSec?: number): Promise<number> {
  const counts = await blameAt(repoPath, head, path, sinceSec);
  if (counts === null) return 0; // file deleted/renamed at HEAD → none of its lines survived as-is
  const exact = counts.get(hash);
  if (exact !== undefined) return exact;
  // An abbreviated hash: sum every full name it prefixes (normally exactly one).
  let count = 0;
  for (const [sha, n] of counts) if (sha.startsWith(hash)) count += n;
  return count;
}

/**
 * What a survival measurement cost, and whether it finished.
 *
 * `measured` is the field that matters. A survival scan is one `git blame
 * --line-porcelain` per touched file per commit, serialized, and on a repository
 * with long files and forty commits that is minutes of work — measured at
 * **416 seconds** on this repository through `/api/value`, which is a route
 * hanging rather than a route answering slowly.
 *
 * Bounding it introduces a worse hazard than the delay, and this type exists to
 * refuse it: a commit whose blame did not run has NOT been shown to have zero
 * retained lines. Returning `surviving: 0` for it would move that commit from
 * unmeasured to churned, deflate the retention ratio, and report a retention
 * signal that no evidence supports. So the caller is handed `measured: false`
 * and must say that retention is unknown.
 */
export interface SurvivingLines {
  readonly added: number;
  readonly surviving: number;
  /**
   * True when every file with added lines was blamed. False means the budget
   * ran out first, and `surviving` is a floor over an unknown remainder rather
   * than a count.
   */
  readonly measured: boolean;
}

/**
 * Count a commit's introduced artifact lines still attributed to it at HEAD.
 *
 * `deadlineMs` is a wall-clock instant, not a duration, so a caller measuring
 * many commits can spend ONE budget across all of them rather than handing each
 * commit a budget that multiplies by the commit count. The deadline is checked
 * between files: a single `git blame` already running is allowed to finish,
 * because killing it would cost the work without producing an answer.
 */
export async function survivingLines(
  repoPath: string,
  hash: string,
  deadlineMs?: number,
  /** Optional history bound for blame; must be older than `hash` (see blameAt). */
  sinceSec?: number,
): Promise<SurvivingLines> {
  const [files, head] = await Promise.all([commitFiles(repoPath, hash), headCommit(repoPath)]);
  let added = 0;
  let surviving = 0;
  let measured = true;
  for (const f of files) {
    added += f.added;
    if (f.added === 0) continue;
    if (head === null || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
      // No HEAD to blame against (an unborn branch) is unmeasured, never zero.
      measured = false;
      continue;
    }
    surviving += await survivingLinesInFile(repoPath, head, hash, f.path, sinceSec);
  }
  return { added, surviving, measured };
}

/** Set of commit hashes that were later reverted (git's default revert message). */
/**
 * What a revert scan actually looked at, alongside what it found.
 *
 * The scan walks back from HEAD over a bounded window, so "no revert found" is
 * only informative for commits the window reached. This carries the boundary so
 * a caller can tell the two apart instead of reading a bounded scan as a
 * complete one (AII-002).
 */
export interface RevertScan {
  /** 7-char prefixes of commits observed to have been reverted. */
  readonly reverted: ReadonlySet<string>;
  /** Commits the scan read. */
  readonly examined: number;
  /**
   * Author timestamp of the OLDEST commit the scan read, or null when it read
   * none. Every commit at or after this instant had its whole post-commit
   * history examined for a revert; anything older did not.
   */
  readonly oldestExaminedMs: number | null;
  /**
   * True when the scan stopped at its window rather than at the beginning of
   * available history — so older reverts exist unobserved, rather than not
   * existing.
   */
  readonly truncated: boolean;
}

/**
 * Scan recent history for reverts, and report the boundary of what was read.
 *
 * A revert of a commit is necessarily NEWER than that commit, so a scan that
 * reached back to a commit has seen every revert of it. That is why the oldest
 * examined timestamp is the completeness boundary, and why a shallow clone —
 * which truncates OLD history — does not by itself impair revert detection for
 * a commit that is visible at all.
 */
export async function revertScan(repoPath: string, limit: number): Promise<RevertScan> {
  const requested = limit * 3;

  // Two reads rather than one delimited read. A commit body can contain any
  // byte, so a single `--format` combining timestamp and body needs a separator
  // that cannot appear in the body — which means an ASCII control character,
  // sitting invisibly in this source file where the next edit would silently
  // destroy it. Two `git log` calls over the same bounded window cost one extra
  // process and keep the parsing legible.
  //
  // %ct (committer timestamp) rather than %at: the boundary is about the order
  // commits entered this history, not when they were originally authored, and a
  // rebase can move %at behind an ancestor's.
  const stampsOut = await git(repoPath, ['log', `-n${requested}`, '--format=%ct']);
  const stamps = stampsOut
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((seconds) => Number.isFinite(seconds));

  const bodies = await git(repoPath, ['log', `-n${requested}`, '--format=%b']);
  const reverted = new Set<string>();
  // Normalize to the 7-char prefix so detection works regardless of the
  // abbreviation length git wrote into the revert message (7, 8, ..., 40).
  for (const match of bodies.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
    reverted.add(match[1]!.slice(0, 7));
  }

  return {
    reverted,
    examined: stamps.length,
    oldestExaminedMs: stamps.length === 0 ? null : Math.min(...stamps) * 1000,
    truncated: stamps.length >= requested,
  };
}

export async function revertedHashes(repoPath: string, limit: number): Promise<Set<string>> {
  return new Set((await revertScan(repoPath, limit)).reverted);
}

/**
 * One coding commit plus its artifact-persistence observation.
 *
 * The legacy scalar fields remain because existing consumers read them. They
 * are projections of `artifactPersistence`, not evidence of a quality grade.
 */
export interface ArtifactPersistenceCommit extends CommitAttribution {
  linesAdded: number;
  survivingLines: number;
  artifactPersistence: ArtifactPersistence;
  survivalRatio: number; // legacy projection: 0..1
  churnRatio: number; // legacy projection: 1 - survivalRatio
  reverted: boolean;
  ageDays: number;
  maturing: boolean; // younger than the maturity window → retention is provisional
  aiYield: number | null; // retained artifact lines per USD, null if no cost
  costPerSurvivingLine: number | null;
}

/** @deprecated Compatibility name; use `ArtifactPersistenceCommit`. */
export type CommitQuality = ArtifactPersistenceCommit;

export interface ArtifactPersistenceReport {
  /** The construct named by every retention observation in this report. */
  construct: ArtifactPersistenceConstruct;
  /** The explicit observable-to-construct relationship for the report. */
  measurementModel: ArtifactPersistenceMeasurementModel;
  /** Literal proposition supported by the measured retention observation. */
  claim: typeof ARTIFACT_PERSISTENCE_CLAIM;
  /** Constructs that this observation does not establish. */
  nonClaims: readonly ArtifactPersistenceNonClaim[];
  windowDays: number;
  generatedAt: string;
  commits: ArtifactPersistenceCommit[];
  matured: {
    commits: number;
    totalCostUsd: number;
    totalAddedLines: number;
    /** Legacy AI-scoped projection retained for compatibility. */
    survivingLines: number;
    /** Retention observation over all matured commits in the report. */
    artifactPersistence: ArtifactPersistence;
    survivalRatio: number; // legacy projection over all matured commits
    churnRatio: number; // legacy projection over all matured commits
    revertRate: number;
    aiYield: number | null; // retained artifact lines per $ across matured AI commits
    costPerSurvivingLine: number | null;
    effectiveSpendRatio: number | null; // cost associated with retained commits / total cost
  };
}

/** @deprecated Compatibility name; use `ArtifactPersistenceReport`. */
export type QualityReport = ArtifactPersistenceReport;

/**
 * Build the artifact-persistence report for the last `limit` commits.
 * Retention is "to date" (blame at HEAD); it is not a quality judgment.
 */
export async function computeArtifactPersistence(
  store: Store,
  repoPath: string,
  opts: { limit?: number; windowDays?: number; persist?: boolean } = {},
): Promise<ArtifactPersistenceReport> {
  const limit = opts.limit ?? 30;
  const windowDays = opts.windowDays ?? 14;
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const attributions = await attributeCommits(store, repoPath, { limit, persist: opts.persist });
  const reverted = await revertedHashes(repoPath, limit);

  const commits: ArtifactPersistenceCommit[] = [];
  for (const a of attributions) {
    const survival = await survivingLines(repoPath, a.hash);
    const { added, surviving } = survival;
    const retainedArtifact = artifactPersistence({
      introducedLines: added,
      retainedLines: surviving,
      measured: survival.measured,
    });
    const survivalRatio = retainedArtifact.retentionRatio ?? 0;
    const ageDays = (now - a.tsEpochMs) / (24 * 60 * 60 * 1000);
    const maturing = now - a.tsEpochMs < windowMs;
    const cost = a.attributedCostUsd;
    const isReverted = reverted.has(a.hash.slice(0, 7));

    commits.push({
      ...a,
      linesAdded: added,
      survivingLines: surviving,
      artifactPersistence: retainedArtifact,
      survivalRatio,
      churnRatio: 1 - survivalRatio,
      reverted: isReverted,
      ageDays,
      maturing,
      aiYield: cost > 0 ? surviving / cost : null,
      costPerSurvivingLine: surviving > 0 ? cost / surviving : null,
    });
  }

  // Retention/churn/revert are artifact observations over all matured commits.
  // They do not measure semantic correctness, maintainability, value, quality,
  // or contribution.
  const mature = commits.filter((c) => !c.maturing);
  const totalAdded = mature.reduce((s, c) => s + c.linesAdded, 0);
  const totalSurviving = mature.reduce((s, c) => s + c.survivingLines, 0);
  const aggregateArtifactPersistence = artifactPersistence({
    introducedLines: totalAdded,
    retainedLines: totalSurviving,
    measured: mature.every((c) => c.artifactPersistence.measured),
  });
  const revertCount = mature.filter((c) => c.reverted).length;

  // Legacy AI Yield/effective-spend projections only count commits with AI cost,
  // so pure-human commits do not pad the retained-lines-per-dollar numerator.
  const aiCommits = mature.filter((c) => c.attributedCostUsd > 0);
  const aiCost = aiCommits.reduce((s, c) => s + c.attributedCostUsd, 0);
  const aiSurviving = aiCommits.reduce((s, c) => s + c.survivingLines, 0);
  const costOnDurable = aiCommits
    .filter((c) => c.survivalRatio >= 0.5 && !c.reverted)
    .reduce((s, c) => s + c.attributedCostUsd, 0);

  return {
    construct: ARTIFACT_PERSISTENCE_CONSTRUCT,
    measurementModel: ARTIFACT_PERSISTENCE_MEASUREMENT_MODEL,
    claim: ARTIFACT_PERSISTENCE_CLAIM,
    nonClaims: ARTIFACT_PERSISTENCE_NON_CLAIMS,
    windowDays,
    generatedAt: new Date(now).toISOString(),
    commits,
    matured: {
      commits: mature.length,
      totalCostUsd: aiCost,
      totalAddedLines: totalAdded,
      survivingLines: aiSurviving,
      artifactPersistence: aggregateArtifactPersistence,
      survivalRatio: totalAdded > 0 ? totalSurviving / totalAdded : 0,
      churnRatio: totalAdded > 0 ? 1 - totalSurviving / totalAdded : 0,
      revertRate: mature.length > 0 ? revertCount / mature.length : 0,
      aiYield: aiCost > 0 ? aiSurviving / aiCost : null,
      costPerSurvivingLine: aiSurviving > 0 ? aiCost / aiSurviving : null,
      effectiveSpendRatio: aiCost > 0 ? costOnDurable / aiCost : null,
    },
  };
}

/**
 * Compatibility entry point retained for existing callers and integrations.
 * The returned report is now explicitly typed as artifact persistence; the old
 * name must not be read as a claim that Git retention measures quality.
 */
export async function computeQuality(
  store: Store,
  repoPath: string,
  opts: { limit?: number; windowDays?: number; persist?: boolean } = {},
): Promise<QualityReport> {
  return computeArtifactPersistence(store, repoPath, opts);
}

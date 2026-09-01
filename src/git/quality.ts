/**
 * Output-quality measurement — the positive half of the product.
 *
 * Cost governance (the proxy) tells you what AI *spent*. This tells you whether
 * that spend produced work worth keeping. It is the replacement for
 * "tokens per developer": instead of measuring activity going in, it measures
 * durable output coming out.
 *
 * Everything here is computed from local git, deterministically, with no CI
 * dependency for the core signal and nothing subjective to grade:
 *
 *   survival(commit) = of the lines this commit ADDED, how many are still in the
 *                      codebase today (via `git blame` at HEAD). Lines that were
 *                      rewritten or deleted = churn = low-quality output.
 *   reverted(commit) = was this commit later reverted (objective, from history).
 *
 * Derived:
 *   AI Yield            = surviving lines / AI cost      (durable output per $)
 *   Effective Spend %   = cost on surviving commits / total cost
 *   Churn               = 1 - survival
 *
 * Honesty: survival needs time to elapse. Commits younger than the maturity
 * window are flagged `maturing` and excluded from the headline aggregate, so we
 * never claim 10-minute-old code is "durable".
 *
 * Goodhart note: these are designed as a *basket* (cost, survival, revert move
 * against each other) and as a *coaching* signal — team trends and aggregates,
 * never a per-developer leaderboard tied to incentives. See docs/RESEARCH-REVIEW.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store/db.ts';
import { attributeCommits, type CommitAttribution } from './correlate.ts';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Files a commit touched, with lines added per file (numstat). */
async function commitFiles(repoPath: string, hash: string): Promise<Array<{ path: string; added: number }>> {
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

/**
 * Count how many lines currently in the file (at HEAD) are still attributed to
 * `hash` by git blame. This is the count of `hash`'s added lines that survived.
 */
async function survivingLinesInFile(repoPath: string, hash: string, path: string): Promise<number> {
  let out: string;
  try {
    out = await git(repoPath, ['blame', '--line-porcelain', 'HEAD', '--', path]);
  } catch {
    return 0; // file deleted/renamed at HEAD → none of its lines survived as-is
  }
  // --line-porcelain emits a header line per source line beginning with the SHA.
  const needle = hash + ' ';
  let count = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith(needle)) count += 1;
  }
  return count;
}

export async function survivingLines(repoPath: string, hash: string): Promise<{ added: number; surviving: number }> {
  const files = await commitFiles(repoPath, hash);
  let added = 0;
  let surviving = 0;
  for (const f of files) {
    added += f.added;
    if (f.added > 0) surviving += await survivingLinesInFile(repoPath, hash, f.path);
  }
  return { added, surviving };
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

export interface CommitQuality extends CommitAttribution {
  linesAdded: number;
  survivingLines: number;
  survivalRatio: number; // 0..1
  churnRatio: number; // 1 - survivalRatio
  reverted: boolean;
  ageDays: number;
  maturing: boolean; // younger than the maturity window → survival is provisional
  aiYield: number | null; // surviving lines per USD, null if no cost
  costPerSurvivingLine: number | null;
}

export interface QualityReport {
  windowDays: number;
  generatedAt: string;
  commits: CommitQuality[];
  matured: {
    commits: number;
    totalCostUsd: number;
    totalAddedLines: number;
    survivingLines: number;
    survivalRatio: number;
    churnRatio: number;
    revertRate: number;
    aiYield: number | null; // surviving lines per $ across matured commits
    costPerSurvivingLine: number | null;
    effectiveSpendRatio: number | null; // cost on surviving commits / total cost
  };
}

/**
 * Build the full quality + yield report for the last `limit` commits.
 * Survival is "to date" (blame at HEAD) — labeled as such in the UI.
 */
export async function computeQuality(
  store: Store,
  repoPath: string,
  opts: { limit?: number; windowDays?: number; persist?: boolean } = {},
): Promise<QualityReport> {
  const limit = opts.limit ?? 30;
  const windowDays = opts.windowDays ?? 14;
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const attributions = await attributeCommits(store, repoPath, { limit, persist: opts.persist });
  const reverted = await revertedHashes(repoPath, limit);

  const commits: CommitQuality[] = [];
  for (const a of attributions) {
    const { added, surviving } = await survivingLines(repoPath, a.hash);
    const survivalRatio = added > 0 ? Math.min(1, surviving / added) : 0;
    const ageDays = (now - a.tsEpochMs) / (24 * 60 * 60 * 1000);
    const maturing = now - a.tsEpochMs < windowMs;
    const cost = a.attributedCostUsd;
    const isReverted = reverted.has(a.hash.slice(0, 7));

    commits.push({
      ...a,
      linesAdded: added,
      survivingLines: surviving,
      survivalRatio,
      churnRatio: 1 - survivalRatio,
      reverted: isReverted,
      ageDays,
      maturing,
      aiYield: cost > 0 ? surviving / cost : null,
      costPerSurvivingLine: surviving > 0 ? cost / surviving : null,
    });
  }

  // Headline aggregate over MATURED commits only (survival has had time to settle).
  const mature = commits.filter((c) => !c.maturing);

  // Survival / churn / revert describe the *code quality of the period* — computed
  // over all matured commits, AI-assisted or not.
  const totalAdded = mature.reduce((s, c) => s + c.linesAdded, 0);
  const totalSurviving = mature.reduce((s, c) => s + c.survivingLines, 0);
  const revertCount = mature.filter((c) => c.reverted).length;

  // AI Yield / effective-spend describe *AI-spend efficiency* — computed only over
  // commits that actually had AI cost attributed, so pure-human commits don't pad
  // the numerator. "Durable output per AI dollar" only counts AI dollars.
  const aiCommits = mature.filter((c) => c.attributedCostUsd > 0);
  const aiCost = aiCommits.reduce((s, c) => s + c.attributedCostUsd, 0);
  const aiSurviving = aiCommits.reduce((s, c) => s + c.survivingLines, 0);
  const costOnDurable = aiCommits
    .filter((c) => c.survivalRatio >= 0.5 && !c.reverted)
    .reduce((s, c) => s + c.attributedCostUsd, 0);

  return {
    windowDays,
    generatedAt: new Date(now).toISOString(),
    commits,
    matured: {
      commits: mature.length,
      totalCostUsd: aiCost,
      totalAddedLines: totalAdded,
      survivingLines: aiSurviving,
      survivalRatio: totalAdded > 0 ? totalSurviving / totalAdded : 0,
      churnRatio: totalAdded > 0 ? 1 - totalSurviving / totalAdded : 0,
      revertRate: mature.length > 0 ? revertCount / mature.length : 0,
      aiYield: aiCost > 0 ? aiSurviving / aiCost : null,
      costPerSurvivingLine: aiSurviving > 0 ? aiCost / aiSurviving : null,
      effectiveSpendRatio: aiCost > 0 ? costOnDurable / aiCost : null,
    },
  };
}

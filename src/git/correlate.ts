/**
 * Git correlation.
 *
 * Maps shipped code to the spend that produced it. For each recent commit we
 * take the window between the previous commit (or a max look-back) and this
 * commit's timestamp, and attribute the AI spend logged in that window to the
 * commit. This yields an honest "cost per commit" — no invented quality score.
 *
 * What we deliberately DON'T compute here: the research's "AI Efficiency Score"
 * with a subjective reusability factor. A gameable efficiency leaderboard would
 * recreate the exact Goodhart's-Law problem the product exists to kill. Cost-
 * per-commit and tokens-per-diff are objective; we stop there for v1.
 *
 * Uses execFile (never exec) so a repo path can't smuggle shell metacharacters.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { Store } from '../store/db.ts';

const run = promisify(execFile);

export interface CommitInfo {
  hash: string;
  tsEpochMs: number;
  subject: string;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
}

export interface CommitAttribution extends CommitInfo {
  windowStartMs: number;
  windowEndMs: number;
  attributedCostUsd: number;
  attributedRequests: number;
  attributedOutputTokens: number;
  costPerHundredLines: number | null;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const out = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Resolve a ref (short hash, branch, HEAD~2) to a full commit hash, or null. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  try {
    const out = await git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function projectName(repoPath: string): Promise<string> {
  try {
    const top = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim();
    return basename(top) || 'default';
  } catch {
    return basename(repoPath) || 'default';
  }
}

/** Read the last `limit` commits with author timestamps and numstat diffs. */
export async function readCommits(repoPath: string, limit: number): Promise<CommitInfo[]> {
  // Prefix each commit's pretty line with a record-separator (\x1e) so the
  // trailing --numstat block stays in the SAME chunk when we split. Fields
  // inside the line are unit-separated (\x1f): hash, author-epoch, subject.
  const fmt = '%x1e%H%x1f%at%x1f%s';
  const out = await git(repoPath, ['log', `-n${limit}`, `--pretty=format:${fmt}`, '--numstat']);
  const commits: CommitInfo[] = [];

  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const head = lines[0] ?? '';
    const [hash, at, subject] = head.split('\x1f');
    if (!hash || !at) continue;
    let added = 0;
    let deleted = 0;
    let files = 0;
    for (const l of lines.slice(1)) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      files += 1;
      if (m[1] !== '-') added += Number(m[1]);
      if (m[2] !== '-') deleted += Number(m[2]);
    }
    commits.push({
      hash,
      tsEpochMs: Number(at) * 1000,
      subject: subject ?? '',
      linesAdded: added,
      linesDeleted: deleted,
      filesChanged: files,
    });
  }
  return commits;
}

/**
 * Attribute logged spend to each commit using the window since the previous
 * commit, capped at maxLookbackMs so a commit after a long break doesn't absorb
 * unrelated spend.
 */
export async function attributeCommits(
  store: Store,
  repoPath: string,
  opts: { limit?: number; maxLookbackHours?: number; persist?: boolean } = {},
): Promise<CommitAttribution[]> {
  const limit = opts.limit ?? 20;
  const maxLookbackMs = (opts.maxLookbackHours ?? 8) * 60 * 60 * 1000;
  const project = await projectName(repoPath);
  const commits = await readCommits(repoPath, limit + 1);

  const results: CommitAttribution[] = [];
  for (let i = 0; i < Math.min(limit, commits.length); i++) {
    const commit = commits[i]!;
    const prev = commits[i + 1];
    const naturalStart = prev ? prev.tsEpochMs : commit.tsEpochMs - maxLookbackMs;
    const windowStartMs = Math.max(naturalStart, commit.tsEpochMs - maxLookbackMs);
    const windowEndMs = commit.tsEpochMs;

    const spend = store.summary(windowStartMs, windowEndMs);
    const totalLines = commit.linesAdded + commit.linesDeleted;
    const costPerHundredLines = totalLines > 0 ? (spend.costUsd / totalLines) * 100 : null;

    const attribution: CommitAttribution = {
      ...commit,
      windowStartMs,
      windowEndMs,
      attributedCostUsd: spend.costUsd,
      attributedRequests: spend.requests,
      attributedOutputTokens: spend.outputTokens,
      costPerHundredLines,
    };
    results.push(attribution);

    if (opts.persist) {
      store.insertCommit({
        commitHash: commit.hash,
        project,
        tsEpochMs: commit.tsEpochMs,
        linesAdded: commit.linesAdded,
        linesDeleted: commit.linesDeleted,
        filesChanged: commit.filesChanged,
        subject: commit.subject,
      });
      store.saveAttribution({
        commitHash: commit.hash,
        windowStartMs,
        windowEndMs,
        attributedCostUsd: spend.costUsd,
        attributedRequests: spend.requests,
        attributedOutputTokens: spend.outputTokens,
      });
    }
  }
  return results;
}

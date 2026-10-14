/**
 * Survival work kept between runs, so a later run spends its budget on what
 * an earlier run did not reach.
 *
 * Two kinds of git output are kept, per repository, in one JSON file under
 * `<SEGREANT_HOME>/survival/`:
 *
 *  - a commit's file list (`git show --numstat`). A commit hash names fixed
 *    content, so its file list never changes; a rewritten commit has a new hash.
 *  - one file's blame at a HEAD: how many of its lines belong to each commit.
 *    Survival is measured at the CURRENT HEAD, so an old blame may only stand in
 *    for a new one when it is the same observation. It is reused only when
 *      1. it was taken at this HEAD, or at an ancestor of it (history was not
 *         rewritten), and
 *      2. no commit between the two touched the path, counting both sides of a
 *         rename and every parent of a merge. Same file contents is not enough:
 *         a change followed by a revert gives the reverted lines a new author.
 *      3. it was taken with a history bound no newer than the one asked for. A
 *         bound collapses older lines onto a boundary commit; every commit newer
 *         than the stored bound has its exact count.
 *    Anything else is blamed again.
 *
 * This is a cache of git's answers, not evidence: deleting the directory loses
 * time, never a figure. It is off unless an entry point turns it on
 * (`configureSurvivalStore`), so tests and library callers never write to a
 * home directory they did not choose.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

const VERSION = 1;
/** Bounds per repository file. Exceeding one drops the oldest half of that map. */
const MAX_BLAME_PATHS = 20_000;
const MAX_COMMITS = 10_000;

interface BlameEntry { head: string; since: number | null; counts: Array<[string, number]> }
interface StoreFile {
  v: number;
  blame: Record<string, BlameEntry>;
  numstat: Record<string, Array<[string, number]>>;
}
interface Loaded { file: string; data: StoreFile; dirty: boolean }

let directory: string | null = null;
const loaded = new Map<string, Loaded>();
const validity = new Map<string, Promise<ReadonlySet<string> | null>>();
let exitHooked = false;

/** Turn persistence on, into `dir`, or off with null. Off is the default. */
export function configureSurvivalStore(dir: string | null): void {
  if (directory !== dir) flushSurvivalStore();
  directory = dir;
  loaded.clear();
  validity.clear();
  if (dir !== null && !exitHooked) {
    exitHooked = true;
    // Synchronous on purpose: 'exit' runs no further asynchronous work, and a
    // CLI command that calls process.exit() still keeps what it measured.
    process.once('exit', flushSurvivalStore);
  }
}

/** Exposed for tests: forget what was read into memory, as a new process would. */
export function forgetLoadedSurvivalStore(): void {
  flushSurvivalStore();
  loaded.clear();
  validity.clear();
}

function repoKey(repoPath: string): string {
  let real = repoPath;
  try { real = realpathSync.native(repoPath); } catch { /* keep the path as given */ }
  return createHash('sha256').update(real.replace(/\\/g, '/')).digest('hex').slice(0, 32);
}

function load(repoPath: string): Loaded | null {
  if (directory === null) return null;
  const key = repoKey(repoPath);
  let hit = loaded.get(key);
  if (hit) return hit;
  const file = join(directory, `${key}.json`);
  let data: StoreFile = { v: VERSION, blame: {}, numstat: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreFile>;
    if (parsed && parsed.v === VERSION && typeof parsed.blame === 'object' && typeof parsed.numstat === 'object') {
      data = { v: VERSION, blame: parsed.blame ?? {}, numstat: parsed.numstat ?? {} };
    }
  } catch { /* missing or unreadable: start empty */ }
  hit = { file, data, dirty: false };
  loaded.set(key, hit);
  return hit;
}

/** Write every changed store. Never throws: a cache that cannot be written only costs time. */
export function flushSurvivalStore(): void {
  for (const store of loaded.values()) {
    if (!store.dirty) continue;
    try {
      mkdirSync(join(store.file, '..'), { recursive: true });
      const tmp = `${store.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.data));
      renameSync(tmp, store.file);
      store.dirty = false;
    } catch { /* read-only home or full disk: keep running without it */ }
  }
}

function trim<T>(map: Record<string, T>, max: number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  for (const k of keys.slice(0, Math.ceil(keys.length / 2))) delete map[k];
}

/** A commit's stored file list, or undefined when it has not been read before. */
export function storedCommitFiles(repoPath: string, hash: string): Array<{ path: string; added: number }> | undefined {
  const rows = load(repoPath)?.data.numstat[hash];
  return rows?.map(([path, added]) => ({ path, added }));
}

export function rememberCommitFiles(repoPath: string, hash: string, files: ReadonlyArray<{ path: string; added: number }>): void {
  const store = load(repoPath);
  if (!store) return;
  store.data.numstat[hash] = files.map((f) => [f.path, f.added]);
  trim(store.data.numstat, MAX_COMMITS);
  store.dirty = true;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Paths any commit after `from` and up to `to` touched, or null when `from` is
 * not an ancestor of `to` (history rewritten, or `from` gone). `-m` lists a
 * merge's changes against every parent and `--no-renames` lists both sides of a
 * rename, so the set can only be too large, which costs a blame, never wrong.
 */
function touchedBetween(repoPath: string, from: string, to: string): Promise<ReadonlySet<string> | null> {
  if (from === to) return Promise.resolve(new Set());
  const key = `${repoKey(repoPath)}\0${from}\0${to}`;
  let pending = validity.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        await git(repoPath, ['merge-base', '--is-ancestor', from, to]);
      } catch {
        return null;
      }
      const out = await git(repoPath, ['log', '-m', '--no-renames', '--name-only', '-z', '--format=', `${from}..${to}`]);
      return new Set(out.split('\0').map((p) => p.replace(/^\n+/, '')).filter((p) => p !== ''));
    })().catch(() => null);
    validity.set(key, pending);
  }
  return pending;
}

/**
 * A stored blame of `path` that is the same observation as blaming it at
 * `head` with `sinceSec`, or undefined when it has to be blamed again.
 */
export async function reusableBlame(repoPath: string, head: string, path: string, sinceSec: number | undefined): Promise<ReadonlyMap<string, number> | undefined> {
  const store = load(repoPath);
  const entry = store?.data.blame[path];
  if (!store || !entry) return undefined;
  // Condition 3: a stored bound newer than the one asked for has collapsed
  // lines the caller needs exactly.
  if (entry.since !== null && (sinceSec === undefined || entry.since > sinceSec)) return undefined;
  if (entry.head !== head) {
    const touched = await touchedBetween(repoPath, entry.head, head);
    if (touched === null || touched.has(path)) return undefined;
    // The same observation at the new HEAD: re-key it, so the next run checks
    // a shorter range.
    entry.head = head;
    store.dirty = true;
  }
  return new Map(entry.counts);
}

export function rememberBlame(repoPath: string, head: string, path: string, sinceSec: number | undefined, counts: ReadonlyMap<string, number>): void {
  const store = load(repoPath);
  if (!store) return;
  store.data.blame[path] = { head, since: sinceSec ?? null, counts: [...counts] };
  trim(store.data.blame, MAX_BLAME_PATHS);
  store.dirty = true;
}

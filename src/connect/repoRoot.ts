/**
 * The git working tree a directory belongs to, found on disk the way git's own
 * discovery finds it, without starting a process.
 *
 * Import attribution used to ask `git rev-parse --show-toplevel` once per
 * distinct working directory. On Windows each spawn costs about 45 ms, so a
 * corpus that touched 54 directories spent 2.6 s of a 5.3 s import waiting on
 * git, in every importer, on every refresh. A CPU profile shows that wait as
 * idle time, which is why it never stood out.
 *
 * Git walks up from the directory and stops at the first ancestor that holds
 * either a `.git` directory it recognises as a repository or a `.git` file
 * whose `gitdir:` line names an existing directory (a linked worktree or a
 * submodule). This does the same, from the physical path, and returns the
 * result in git's format: forward slashes on Windows, symlinks resolved, the
 * on-disk letter case.
 *
 * Where this can differ from git, and why that is acceptable for a label:
 * - git refuses a repository owned by another user (`safe.directory`); this
 *   still finds its root. The label is the repository's name either way.
 * - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES` and `core.worktree`
 *   are not consulted. A tool's session directory does not set them.
 * - a bare repository, or the inside of a `.git` folder, has no work tree:
 *   git and this both return null there.
 * The basis recorded with the label stays an inference (see CONTEXT.md).
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The first line of a small pointer file (`.git`, `commondir`), or null. */
function firstLine(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return (buf.toString('utf8', 0, n).split(/\r?\n/, 1)[0] ?? '').trim();
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A path written inside a git pointer file is relative to that file's folder. */
function fromPointer(file: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(file), target);
}

/**
 * git's own minimum for a directory to count as a repository: a HEAD, plus
 * objects and refs. A linked worktree's git directory keeps those two in the
 * main repository and names it in a `commondir` file.
 */
function isGitDirectory(dir: string): boolean {
  try {
    if (!statSync(join(dir, 'HEAD')).isFile()) return false;
    const common = firstLine(join(dir, 'commondir'));
    const shared = common ? fromPointer(join(dir, 'commondir'), common) : dir;
    return statSync(join(shared, 'objects')).isDirectory() && statSync(join(shared, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/** A `.git` file names the real git directory: "gitdir: <path>". */
function gitFileTarget(file: string): string | null {
  const m = /^gitdir: (.+)$/.exec(firstLine(file) ?? '');
  return m ? fromPointer(file, m[1]!.trim()) : null;
}

function gitFormat(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

export function repoToplevelOnDisk(dir: string): string | null {
  let current: string;
  try {
    // .native keeps the on-disk case on Windows and macOS, as git reports it.
    current = realpathSync.native(dir);
    if (!statSync(current).isDirectory()) return null;
  } catch {
    return null; // a deleted or unreadable directory: git fails here too
  }
  for (;;) {
    const marker = join(current, '.git');
    let kind: 'dir' | 'file' | null = null;
    try {
      const st = statSync(marker);
      kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    } catch {
      kind = null;
    }
    if (kind === 'dir' && isGitDirectory(marker)) return gitFormat(current);
    if (kind === 'file') {
      // A broken pointer is fatal to git; it does not keep looking further up.
      const target = gitFileTarget(marker);
      return target !== null && isGitDirectory(target) ? gitFormat(current) : null;
    }
    // Inside a git directory itself (a bare repository, or a `.git` folder):
    // git finds the repository but there is no work tree to name.
    if (isGitDirectory(current)) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Private per-process copy of the compiled runtime, used by the CLI launcher.
//
// The launcher has to release the publication gate as soon as the copy exists —
// holding it for the length of a command would starve every queued build — but
// the command it launched can go on resolving modules and reading bundled
// resources long after that. `fiscus start` is the case that decides the shape
// of this module: it resolves its command promise the moment the proxy and
// dashboard sockets are listening, then serves for hours, and the dashboard
// reads the bundled pricing card per REQUEST rather than at import.
//
// So the snapshot's correctness condition is a lifetime, not a completion. It
// must outlive the process that imported it; cleanup belongs to process exit.
// A process killed before that (SIGKILL, a closed terminal) leaves an
// owner-stamped directory that a later launcher reaps once its owner is
// demonstrably dead — never by pathname, which would delete a running server's
// module tree out from under it.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_STALE_MS, processIsAlive } from './publication-lock.mjs';

export const SNAPSHOT_PREFIX = 'fiscus-runtime-';
export const SNAPSHOT_OWNER_FILE = 'owner.json';

// The compiled runtime resolves these relative to the PACKAGE root rather than
// to its own module: the bundled pricing card, the Lift baselines, and the
// package version. A snapshot without them is not behaviourally equivalent to
// the checked-out or installed layout, and the difference only surfaces at the
// first request that needs one.
const ROOT_RESOURCES = ['pricing', 'baselines', 'package.json'];

const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 };

function removeTree(path) {
  try {
    rmSync(path, REMOVE_OPTIONS);
    return true;
  } catch {
    // Windows antivirus/indexer handles can briefly hold a just-copied file.
    // A surviving snapshot is temp-directory residue that the reaper collects
    // on a later run; it must never turn a completed command into a failure.
    return false;
  }
}

function readSnapshotOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, SNAPSHOT_OWNER_FILE), 'utf8'));
    if (!owner || typeof owner !== 'object') return null;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
    return { pid: owner.pid };
  } catch {
    return null;
  }
}

/**
 * Remove snapshots left behind by processes that are gone.
 *
 * Liveness, not age, is the primary test: a `fiscus start` can legitimately own
 * its snapshot for days, so an age-only reaper would delete a live server's
 * runtime. Age only decides for a directory with no readable owner record,
 * which can exist solely in the sliver between `mkdtemp` and the owner write.
 */
export function reapOrphanRuntimeSnapshots(parent = tmpdir()) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_PREFIX)) continue;
    const path = join(parent, entry.name);
    const owner = readSnapshotOwner(path);
    if (owner) {
      if (!processIsAlive(owner.pid)) removeTree(path);
      continue;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) removeTree(path);
    } catch {
      // A concurrent reaper won, or the directory vanished. Nothing to do.
    }
  }
}

/**
 * Copy the compiled runtime and its package-root resources into a private tree.
 *
 * Call this while the publication lock is held: the copy is what makes every
 * later module resolution and resource read independent of a concurrent build.
 * The returned `dispose` is idempotent and safe to register on process exit.
 */
export function createRuntimeSnapshot(packageRoot, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, SNAPSHOT_PREFIX));
  try {
    // Stamp ownership before the expensive copy, so an interrupted creation is
    // still reapable by liveness rather than having to age out.
    writeFileSync(join(root, SNAPSHOT_OWNER_FILE), JSON.stringify({ pid: process.pid }), 'utf8');
    cpSync(join(packageRoot, 'dist'), join(root, 'dist'), { recursive: true, force: true, errorOnExist: false });
    for (const resource of ROOT_RESOURCES) {
      const source = join(packageRoot, resource);
      if (existsSync(source)) {
        cpSync(source, join(root, resource), { recursive: true, force: true, errorOnExist: false });
      }
    }
  } catch (error) {
    removeTree(root);
    throw error;
  }

  let disposed = false;
  return {
    root,
    entry: join(root, 'dist', 'cli.js'),
    dispose() {
      if (disposed) return;
      disposed = true;
      removeTree(root);
    },
  };
}

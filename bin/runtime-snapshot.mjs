// Immutable copy of the compiled runtime, used by the CLI launcher.
//
// The launcher has to release the publication gate as soon as the copy exists —
// holding it for the length of a command would starve every queued build — but
// the command it launched can go on resolving modules and reading bundled
// resources long after that. `segreant start` is the case that decides the shape
// of this module: it resolves its command promise the moment the proxy and
// dashboard sockets are listening, then serves for hours, and the dashboard
// reads the bundled pricing card per REQUEST rather than at import.
//
// So the snapshot's correctness condition is a lifetime, not a completion. It
// must outlive every process that imported it.
//
// The copy is keyed by a hash of its contents and shared by every launch of the
// same build. A fresh copy per process was correct but slow: on Windows the
// first open of each newly written module file costs about a second across the
// module graph, on every command. A content-keyed copy is never modified after
// it is complete, so sharing it cannot hand a process a half-published build: a
// new build hashes differently and gets its own directory.
//
// Each process holds a lease file inside the snapshot while it runs. Shared
// snapshots are created, leased and reaped only under one machine-wide
// snapshot lock. The package's own publication lock is not enough: two package
// roots with identical builds (a checkout and a copy of it) hash to the same
// snapshot but hold different publication locks, and a reaper in one could
// remove the snapshot another had just created and not yet leased. A snapshot
// is reaped when no live process leases it, it is not the current build's, and
// nothing has leased it for SHARED_IDLE_MS. A process killed mid-copy leaves an owner-stamped private
// directory that a later launcher reaps once its owner is demonstrably dead —
// never by pathname, which could delete a running server's module tree.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePublicationLock, LOCK_STALE_MS, processIsAlive } from './publication-lock.mjs';

export const SNAPSHOT_PREFIX = 'segreant-runtime-';
export const SHARED_SNAPSHOT_PREFIX = `${SNAPSHOT_PREFIX}build-`;
export const SNAPSHOT_OWNER_FILE = 'owner.json';
export const SNAPSHOT_COMPLETE_FILE = 'complete.json';
export const SNAPSHOT_LEASE_DIR = 'leases';
// Deliberately outside SNAPSHOT_PREFIX, so the orphan reaper never touches it.
export const SNAPSHOT_LOCK_DIR = 'segreant-snapshot-lock';
// An unleased snapshot of another build survives this long after its last
// lease, so two checkouts used alternately do not re-copy on every command.
export const SHARED_IDLE_MS = 10 * 60_000;

// The compiled runtime resolves these relative to the PACKAGE root rather than
// to its own module: the bundled pricing card, the Lift baselines, the public
// market snapshot, and the package version. A snapshot without them is not behaviourally equivalent to
// the checked-out or installed layout, and the difference only surfaces at the
// first request that needs one.
const ROOT_RESOURCES = ['pricing', 'baselines', 'market', 'package.json'];

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

/** Content hash of everything a snapshot copies, in a stable order. */
export function runtimeKey(packageRoot) {
  const hash = createHash('sha256');
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else {
        hash.update(`${name}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  for (const resource of ['dist', ...ROOT_RESOURCES]) {
    const path = join(packageRoot, resource);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path, resource);
    else {
      hash.update(`${resource}\0`);
      hash.update(readFileSync(path));
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 32);
}

function liveLeases(path) {
  let names;
  try {
    names = readdirSync(join(path, SNAPSHOT_LEASE_DIR));
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ''));
    if (processIsAlive(pid)) live++;
    else rmSync(join(path, SNAPSHOT_LEASE_DIR, name), { force: true });
  }
  return live;
}

/** Time since the snapshot was last leased (its completion marker is touched on every lease). */
function idleFor(path) {
  for (const candidate of [join(path, SNAPSHOT_COMPLETE_FILE), path]) {
    try {
      return Date.now() - statSync(candidate).mtimeMs;
    } catch {
      // Try the directory itself.
    }
  }
  return Infinity;
}

/**
 * Remove snapshots left behind by processes that are gone.
 *
 * Liveness, not age, is the primary test: a `segreant start` can legitimately own
 * its snapshot for days, so an age-only reaper would delete a live server's
 * runtime. Age only decides for a directory with no readable owner record,
 * which can exist solely in the sliver between `mkdtemp` and the owner write.
 *
 * Shared build snapshots are reaped only when `currentKey` is given, which
 * createRuntimeSnapshot does while holding the machine-wide snapshot lock: then
 * no launcher, from any package root, can be between creating or leasing a
 * snapshot and recording its lease.
 */
export function reapOrphanRuntimeSnapshots(parent = tmpdir(), currentKey = null) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_PREFIX)) continue;
    const path = join(parent, entry.name);
    if (entry.name.startsWith(SHARED_SNAPSHOT_PREFIX)) {
      if (currentKey === null || entry.name === `${SHARED_SNAPSHOT_PREFIX}${currentKey}`) continue;
      if (liveLeases(path) === 0 && idleFor(path) > SHARED_IDLE_MS) removeTree(path);
      continue;
    }
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

function copyRuntime(packageRoot, root) {
  cpSync(join(packageRoot, 'dist'), join(root, 'dist'), { recursive: true, force: true, errorOnExist: false });
  for (const resource of ROOT_RESOURCES) {
    const source = join(packageRoot, resource);
    if (existsSync(source)) {
      cpSync(source, join(root, resource), { recursive: true, force: true, errorOnExist: false });
    }
  }
}

/**
 * Lease the shared snapshot of the current build, creating it if needed.
 *
 * Call this while the package's publication lock is held: that makes the copy
 * independent of a concurrent build. It takes the machine-wide snapshot lock
 * itself, which keeps every reaper, from any package root, from removing a
 * snapshot between its creation or lease and the recorded lease. The returned `dispose`
 * releases the lease; it is idempotent and safe to register on process exit.
 */
export function createRuntimeSnapshot(packageRoot, parent = tmpdir()) {
  const key = runtimeKey(packageRoot);
  const lockRoot = join(parent, SNAPSHOT_LOCK_DIR);
  mkdirSync(lockRoot, { recursive: true });
  const release = acquirePublicationLock(lockRoot);
  try {
    return leaseSharedSnapshot(packageRoot, parent, key);
  } finally {
    release?.();
  }
}

function leaseSharedSnapshot(packageRoot, parent, key) {
  const root = join(parent, `${SHARED_SNAPSHOT_PREFIX}${key}`);
  if (!existsSync(join(root, SNAPSHOT_COMPLETE_FILE))) {
    // An incomplete shared directory can only be residue of a failed rename.
    if (existsSync(root)) removeTree(root);
    const staging = mkdtempSync(join(parent, SNAPSHOT_PREFIX));
    try {
      // Stamp ownership before the expensive copy, so an interrupted creation is
      // still reapable by liveness rather than having to age out.
      writeFileSync(join(staging, SNAPSHOT_OWNER_FILE), JSON.stringify({ pid: process.pid }), 'utf8');
      copyRuntime(packageRoot, staging);
      writeFileSync(join(staging, SNAPSHOT_COMPLETE_FILE), JSON.stringify({ key }), 'utf8');
      rmSync(join(staging, SNAPSHOT_OWNER_FILE), { force: true });
      renameSync(staging, root);
    } catch (error) {
      removeTree(staging);
      throw error;
    }
  }
  const lease = join(root, SNAPSHOT_LEASE_DIR, `${process.pid}.json`);
  mkdirSync(join(root, SNAPSHOT_LEASE_DIR), { recursive: true });
  writeFileSync(lease, JSON.stringify({ pid: process.pid }), 'utf8');
  const now = new Date();
  try {
    utimesSync(join(root, SNAPSHOT_COMPLETE_FILE), now, now);
  } catch {
    // The idle clock is advisory; a live lease is what protects the tree.
  }
  reapOrphanRuntimeSnapshots(parent, key);

  let disposed = false;
  return {
    root,
    key,
    entry: join(root, 'dist', 'cli.js'),
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        rmSync(lease, { force: true });
      } catch {
        // A lease left behind names a dead pid; the next reaper discards it.
      }
    },
  };
}

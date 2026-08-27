import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const buildLock = join(root, '.fiscus-build.lock');

// A build is allowed to compile in parallel with another build, but publication
// must be serialized. The lock is deliberately outside dist: dist remains a
// usable last-known-good tree while a new tree is being compiled or published.
const LOCK_WAIT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 25;
const RENAME_RETRY_MS = 5_000;
const OWNER_FILE = 'owner.json';
const OWNER_QUARANTINE_FILE = '.owner-quarantine.json';
const LOCK_QUARANTINE_PREFIX = '.fiscus-build.lock.quarantine-';
const waitCell = new Int32Array(new SharedArrayBuffer(4));

class BuildFailure extends Error {
  constructor(label, exitCode) {
    super(`build failed: ${label}`);
    this.label = label;
    this.exitCode = exitCode;
  }
}

function sleep(milliseconds) {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Any other error
    // (most importantly ESRCH) means that the owner is gone.
    return error?.code === 'EPERM';
  }
}

function readOwnerFile(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (!owner || typeof owner !== 'object') return null;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
    if (typeof owner.token !== 'string' || owner.token.length === 0) return null;
    return { pid: owner.pid, token: owner.token };
  } catch {
    return null;
  }
}

function ownerQuarantineNames(lockPath) {
  try {
    return readdirSync(lockPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (
        entry.name === OWNER_QUARANTINE_FILE || entry.name.startsWith('.owner-quarantine-')
      ))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function inspectLock() {
  let lockStat;
  try {
    lockStat = statSync(buildLock);
  } catch {
    return null;
  }

  const ownerPath = join(buildLock, OWNER_FILE);
  const owner = readOwnerFile(ownerPath);
  if (owner) return { lockStat, owner, ownerPath };

  // A reclaimer may have atomically moved the owner record aside and then
  // crashed. Keep that token-bearing record as the lock identity so a later
  // reclaimer cannot mistake the partially recovered directory for a new one.
  for (const name of ownerQuarantineNames(buildLock)) {
    const quarantinedOwner = readOwnerFile(join(buildLock, name));
    if (quarantinedOwner) {
      return { lockStat, owner: quarantinedOwner, ownerPath: join(buildLock, name) };
    }
  }

  return { lockStat, owner: null, ownerPath: null };
}

function lockIsStale(snapshot = inspectLock()) {
  if (!snapshot) return true;
  if (snapshot.owner) return !processIsAlive(snapshot.owner.pid);

  // The creator writes owner.json immediately after mkdir. Treat a very young,
  // partially-written lock as live; recover an interrupted creator after a
  // bounded age rather than deleting another build's lock.
  return Date.now() - snapshot.lockStat.mtimeMs > LOCK_STALE_MS;
}

function sameOwner(left, right) {
  return left?.pid === right?.pid && left?.token === right?.token;
}

function renameForQuarantine(source, target) {
  const started = Date.now();
  while (Date.now() - started < RENAME_RETRY_MS) {
    try {
      renameSync(source, target);
      return true;
    } catch (error) {
      // A competing reclaimer may have claimed the owner record first. On
      // Windows, antivirus/indexer handles can also briefly deny a rename;
      // retry those transient states without ever falling back to deletion.
      if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      sleep(LOCK_POLL_MS);
    }
  }
  return false;
}

function restoreQuarantinedLock(quarantine) {
  try {
    renameSync(quarantine, buildLock);
    return true;
  } catch (error) {
    // If another process acquired the canonical path during a recovery of an
    // unknown/malformed lock, leave both generations untouched. In particular,
    // never recursively delete the quarantine to make the error disappear.
    if (['ENOENT', 'EACCES', 'EBUSY', 'EPERM', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}

function quarantineUnknownLock() {
  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return false;

  // Unknown means owner.json was absent or malformed. If a valid owner appears
  // in the atomically quarantined object, this was a newer lock generation and
  // it is not ours to delete. Restore it to the canonical path when possible.
  const owner = readOwnerFile(join(quarantine, OWNER_FILE));
  if (owner || ownerQuarantineNames(quarantine).some((name) => readOwnerFile(join(quarantine, name)))) {
    restoreQuarantinedLock(quarantine);
    return false;
  }

  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function quarantineKnownLock(snapshot) {
  if (!snapshot.owner || !snapshot.ownerPath) return false;

  // First quarantine the token-bearing owner record while the canonical lock
  // directory remains in place. That closes the stale-check -> removal window:
  // no other builder can acquire the directory until this owner identity has
  // been claimed by an atomic same-directory rename.
  const ownerName = OWNER_QUARANTINE_FILE;
  const ownerQuarantine = join(buildLock, ownerName);
  if (snapshot.ownerPath !== ownerQuarantine) {
    // One fixed quarantine name makes the owner-record claim itself exclusive:
    // competing stale recoverers observe the same claimed generation and wait
    // instead of moving one another's temporary records around.
    if (existsSync(ownerQuarantine) || !renameForQuarantine(snapshot.ownerPath, ownerQuarantine)) return false;
  }
  const movedOwner = readOwnerFile(ownerQuarantine);
  if (!sameOwner(movedOwner, snapshot.owner)) {
    try { renameSync(ownerQuarantine, snapshot.ownerPath); } catch { /* leave it for stale recovery */ }
    return false;
  }

  // Now move the whole claimed lock to a unique sibling. Publication contenders
  // can create a fresh canonical lock after this point, but they can never be
  // affected by cleanup of this quarantined generation.
  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return false;
  const quarantinedOwner = readOwnerFile(join(quarantine, ownerName));
  if (!sameOwner(quarantinedOwner, snapshot.owner)) {
    restoreQuarantinedLock(quarantine);
    return false;
  }

  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function quarantineStaleLock(snapshot) {
  return snapshot?.owner ? quarantineKnownLock(snapshot) : quarantineUnknownLock();
}

function releaseBuildLock(token) {
  const snapshot = inspectLock();
  if (!snapshot?.owner || snapshot.owner.token !== token || !snapshot.ownerPath) return;

  // Release uses the same atomic owner-record quarantine as stale recovery. A
  // pathname read followed by recursive deletion would otherwise have the same
  // replacement race if a lock were externally changed during cleanup.
  const ownerName = OWNER_QUARANTINE_FILE;
  const ownerQuarantine = join(buildLock, ownerName);
  if (snapshot.ownerPath !== ownerQuarantine && !renameForQuarantine(snapshot.ownerPath, ownerQuarantine)) return;
  const movedOwner = readOwnerFile(ownerQuarantine);
  if (!movedOwner || movedOwner.token !== token) {
    try { renameSync(ownerQuarantine, snapshot.ownerPath); } catch { /* preserve an uncertain lock */ }
    return;
  }

  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}release-${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return;
  const quarantinedOwner = readOwnerFile(join(quarantine, ownerName));
  if (!quarantinedOwner || quarantinedOwner.token !== token) {
    restoreQuarantinedLock(quarantine);
    return;
  }
  rmSync(quarantine, { recursive: true, force: true });
}

function acquireBuildLock() {
  const waitStarted = Date.now();
  const token = randomUUID();

  while (true) {
    let created = false;
    try {
      mkdirSync(buildLock);
      created = true;

      // Publish the owner record through a same-directory rename so a waiter
      // never mistakes a half-written JSON file for an actionable owner.
      const ownerTemp = join(buildLock, `.owner-${token}.tmp`);
      writeFileSync(ownerTemp, JSON.stringify({ pid: process.pid, token }), 'utf8');
      renameSync(ownerTemp, join(buildLock, 'owner.json'));

      return () => releaseBuildLock(token);
    } catch (error) {
      if (created) {
        // The mkdir succeeded, so this process owns the not-yet-published lock.
        // Still clean it through quarantine: a direct recursive removal would
        // turn an exceptional owner-record write into another TOCTOU window.
        const snapshot = inspectLock();
        if (snapshot && (!snapshot.owner || snapshot.owner.token === token)) {
          if (snapshot.owner) quarantineKnownLock(snapshot);
          else quarantineUnknownLock();
        }
      }
      if (error?.code !== 'EEXIST') throw error;

      const snapshot = inspectLock();
      if (lockIsStale(snapshot) && quarantineStaleLock(snapshot)) {
        continue;
      }
      if (Date.now() - waitStarted >= LOCK_WAIT_MS) {
        throw new Error(`timed out waiting for another Fiscus build (${LOCK_WAIT_MS}ms)`);
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

function compile(project, label, outDir) {
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--outDir', outDir], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new BuildFailure(label, result.status ?? 1);
}

function stagedFiles(directory) {
  const files = [];

  function walk(current, relative = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? join(relative, entry.name) : entry.name;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      } else {
        throw new Error(`unsupported build artifact type: ${child}`);
      }
    }
  }

  if (existsSync(directory)) walk(directory);
  return files;
}

function renameWithRetry(source, target) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RENAME_RETRY_MS) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      // Windows can briefly deny replacement while a concurrent reader (for
      // example npm pack) still has the old file open. Keep the destination
      // untouched and retry; a real shape/permission error is surfaced after
      // the bounded window rather than falling back to a delete-and-gap.
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      lastError = error;
      sleep(LOCK_POLL_MS);
    }
  }
  throw lastError;
}

function replaceFileAtomically(source, target, temporaryDirectory) {
  mkdirSync(dirname(target), { recursive: true });
  // Keep the temporary sibling on the same filesystem as dist while keeping
  // it outside dist itself. npm pack and other readers therefore never see an
  // in-flight artifact, and renameSync remains an atomic same-volume move on
  // both Windows and POSIX.
  const temporary = join(temporaryDirectory, `.publish-${process.pid}-${randomUUID()}.tmp`);
  try {
    // The copy completes outside the published path. renameSync then replaces
    // one existing file in one filesystem operation on Windows and POSIX.
    copyFileSync(source, temporary);
    renameWithRetry(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeEmptyDirectories(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    removeEmptyDirectories(child);
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
  }
}

function publish(stage, { prune }) {
  const release = acquireBuildLock();
  try {
    mkdirSync(dist, { recursive: true });

    // Keep the entrypoint until every dependency is ready. A process that
    // starts during publication therefore continues to resolve the previous
    // complete CLI rather than observing a newly-written entrypoint with a
    // missing dependency.
    const files = stagedFiles(stage).sort((a, b) => {
      if (a === 'cli.js') return 1;
      if (b === 'cli.js') return -1;
      return a.localeCompare(b);
    });
    for (const relative of files) {
      replaceFileAtomically(join(stage, relative), join(dist, relative), stage);
    }

    if (prune) {
      const expected = new Set(files);
      for (const relative of stagedFiles(dist)) {
        if (!expected.has(relative)) rmSync(join(dist, relative), { force: true });
      }
      removeEmptyDirectories(dist);
    }
  } finally {
    release();
  }
}

/**
 * `--web` emits only the browser app and its static assets — the targeted
 * slice used when iterating on GUI output. The ordinary `npm test` pretest
 * uses the full build because package-boundary tests also inspect the Node
 * runtime artifacts in dist/.
 *
 * Every pass is built in a unique temporary tree. A successful full build is
 * then published file-by-file under a short publication lock, with each file
 * copied to a temporary sibling before replacement. This preserves the
 * previous complete dist/ tree during compilation and prevents the old
 * rmSync(dist) race from exposing an empty or partially-created runtime.
 *
 * `--web` still skips the node-runtime pass and does not prune dist/; it merges
 * the browser output only, preserving the documented partial-iteration
 * behavior and the existing node runtime.
 */
const webOnly = process.argv.includes('--web');
let stage;
let exitCode = 0;

try {
  // Stage beside dist so every publication rename is same-volume even on a
  // machine whose system temp directory is mounted elsewhere.
  stage = mkdtempSync(join(root, '.fiscus-build-'));

  // Pass 1 — the Node runtime (CLI, proxy, store, dashboard server).
  if (!webOnly) compile(join(root, 'tsconfig.build.json'), 'node runtime', stage);

  // Pass 2 — the browser app. Its own config carries the DOM lib and no node
  // types, so server code cannot reach a browser global and the GUI cannot
  // reach a node one. Same compiler, no bundler: emitted files are plain,
  // inspectable ES modules.
  const webApp = join(root, 'src', 'dashboard', 'web', 'app');
  if (!existsSync(webApp)) throw new Error('Web app sources are missing from src/dashboard/web/app.');
  const webOutput = join(stage, 'dashboard', 'web', 'app');
  compile(join(webApp, 'tsconfig.json'), 'browser app', webOutput);

  // Static assets: everything under web/ that is NOT a TypeScript source or a
  // tsconfig. The .ts files became .js in pass 2; copying them too would ship
  // the same code twice and let a stale copy be served.
  const dashboardSource = join(root, 'src', 'dashboard', 'web');
  const dashboardOutput = join(stage, 'dashboard', 'web');
  if (!existsSync(dashboardSource)) throw new Error('Dashboard static assets are missing from src/dashboard/web.');
  cpSync(dashboardSource, dashboardOutput, {
    recursive: true,
    filter: (source) => !source.endsWith('.ts') && !source.endsWith('tsconfig.json'),
  });

  publish(stage, { prune: !webOnly });
} catch (error) {
  if (error instanceof BuildFailure) {
    console.error(`  ${error.message}`);
    exitCode = error.exitCode;
  } else {
    console.error(error);
    exitCode = 1;
  }
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true });
}

process.exitCode = exitCode;

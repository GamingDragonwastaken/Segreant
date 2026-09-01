// Shared cross-process publication gate for the build and the supported CLI
// launcher.  This module intentionally has no side effects on import: the
// package launcher can use it before resolving any generated runtime module.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// A full cross-platform test/build fan-out can legitimately queue several
// publication attempts behind slow filesystem/module-loader work. Keep the
// wait finite for a genuinely wedged live owner, but do not turn that queue into
// a false build failure at the old two-minute boundary.
export const LOCK_WAIT_MS = 300_000;
export const LOCK_STALE_MS = 10 * 60_000;
export const LOCK_POLL_MS = 25;
export const RENAME_RETRY_MS = 5_000;
/**
 * How long a canonical-path filesystem error is treated as contention before it
 * is reported as itself. A directory in pending-delete clears in milliseconds; a
 * read-only parent never does, and must not be reported as a wait timeout.
 */
export const PATH_CONTENTION_MS = 5_000;
export const OWNER_FILE = 'owner.json';
export const OWNER_QUARANTINE_FILE = '.owner-quarantine.json';
export const LOCK_QUARANTINE_PREFIX = '.fiscus-build.lock.quarantine-';

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function sleep(milliseconds) {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function removeQuarantine(path) {
  try {
    // Windows antivirus/indexer handles can briefly keep a just-renamed file
    // open. Retry the generated quarantine cleanup so a successful publication
    // does not leave a misleading lock-generation directory in the repository.
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: LOCK_POLL_MS });
  } catch {
    // The canonical lock has already been moved away. Preserve an uncertain
    // quarantine rather than risking a path-based delete of a new generation;
    // the next acquisition can safely inspect/reclaim it by owner token.
  }
}

/**
 * Shared with the runtime-snapshot reaper: both subsystems decide whether a
 * recorded owner is gone, and the EPERM case below is exactly the distinction
 * that must not be reimplemented differently in two places.
 */
export function processIsAlive(pid) {
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

function inspectLock(buildLock) {
  let lockStat;
  try {
    lockStat = statSync(buildLock);
  } catch {
    return null;
  }

  const ownerPath = join(buildLock, OWNER_FILE);
  const owner = readOwnerFile(ownerPath);
  if (owner) return { lockStat, owner, ownerPath };

  // The creator writes a complete JSON owner record to a token-specific temp
  // name before the same-directory rename to owner.json. If that creator is
  // interrupted in the tiny interval between those operations, the lock is
  // still recoverable: retain the token-bearing temp path as the identity and
  // run the normal PID-aware quarantine flow. Treating it as an unknown,
  // owner-less lock would impose the full stale age even when its process is
  // already dead, which can wedge every queued build/reader for minutes.
  let ownerTemps = [];
  try {
    ownerTemps = readdirSync(buildLock, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.owner-[0-9a-f-]+\.tmp$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    ownerTemps = [];
  }
  for (const name of ownerTemps) {
    const temporaryOwner = readOwnerFile(join(buildLock, name));
    if (temporaryOwner) return { lockStat, owner: temporaryOwner, ownerPath: join(buildLock, name) };
  }

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

function lockIsStale(buildLock, snapshot = inspectLock(buildLock)) {
  if (!snapshot) return true;
  if (snapshot.owner) return !processIsAlive(snapshot.owner.pid);

  // The creator writes owner.json immediately after mkdir. Treat a very young,
  // partially-written lock as live; recover an interrupted creator after a
  // bounded age rather than deleting another process's lock.
  return Date.now() - snapshot.lockStat.mtimeMs > LOCK_STALE_MS;
}

function reapOrphanQuarantines(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(LOCK_QUARANTINE_PREFIX)) continue;
    const path = join(root, entry.name);
    const snapshot = inspectLock(path);
    // A quarantine is no longer on the acquisition path. It is safe to reap
    // only when its owner is demonstrably dead (or its owner-less generation
    // has aged past the same stale threshold); a live/uncertain generation is
    // preserved for a later acquisition rather than deleted by pathname.
    if (lockIsStale(path, snapshot)) removeQuarantine(path);
  }
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

function restoreQuarantinedLock(buildLock, quarantine) {
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

function quarantineUnknownLock(root, buildLock) {
  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return false;

  // Unknown means owner.json was absent or malformed. If a valid owner appears
  // in the atomically quarantined object, this was a newer lock generation and
  // it is not ours to delete. Restore it to the canonical path when possible.
  const owner = readOwnerFile(join(quarantine, OWNER_FILE));
  if (owner || ownerQuarantineNames(quarantine).some((name) => readOwnerFile(join(quarantine, name)))) {
    restoreQuarantinedLock(buildLock, quarantine);
    return false;
  }

  removeQuarantine(quarantine);
  return true;
}

function quarantineKnownLock(root, buildLock, snapshot) {
  if (!snapshot.owner || !snapshot.ownerPath) return false;

  // First quarantine the token-bearing owner record while the canonical lock
  // directory remains in place. That closes the stale-check -> removal window:
  // no other process can acquire the directory until this owner identity has
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

  // Now move the whole claimed lock to a unique sibling. Publication
  // contenders can create a fresh canonical lock after this point, but they
  // can never be affected by cleanup of this quarantined generation.
  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return false;
  const quarantinedOwner = readOwnerFile(join(quarantine, ownerName));
  if (!sameOwner(quarantinedOwner, snapshot.owner)) {
    restoreQuarantinedLock(buildLock, quarantine);
    return false;
  }

  removeQuarantine(quarantine);
  return true;
}

function quarantineStaleLock(root, buildLock, snapshot) {
  return snapshot?.owner
    ? quarantineKnownLock(root, buildLock, snapshot)
    : quarantineUnknownLock(root, buildLock);
}

function releasePublicationLock(root, buildLock, token) {
  const snapshot = inspectLock(buildLock);
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
    restoreQuarantinedLock(buildLock, quarantine);
    return;
  }
  removeQuarantine(quarantine);
}

/**
 * Acquire the exclusive build/reader gate rooted beside the package.
 *
 * Both the publisher and bin/fiscus.mjs use this exact mkdir protocol. A
 * reader therefore cannot observe the check-vs-acquire window where a build
 * starts publication immediately after a reader sees an absent lock. Stale
 * recovery is token- and PID-aware and never falls back to path-based deletion.
 */
export function acquirePublicationLock(root) {
  reapOrphanQuarantines(root);
  const buildLock = join(root, '.fiscus-build.lock');
  const waitStarted = Date.now();
  const token = randomUUID();
  // First moment the canonical path answered with a filesystem error that is
  // not EEXIST. Reset on any other outcome, so the budget below bounds a
  // CONSECUTIVE run of them rather than their total over a long wait.
  let unusableSince = null;

  while (true) {
    let created = false;
    try {
      mkdirSync(buildLock);
      created = true;

      // Publish the owner record through a same-directory rename so a waiter
      // never mistakes a half-written JSON file for an actionable owner.
      const ownerTemp = join(buildLock, `.owner-${token}.tmp`);
      writeFileSync(ownerTemp, JSON.stringify({ pid: process.pid, token }), 'utf8');
      renameSync(ownerTemp, join(buildLock, OWNER_FILE));

      return () => releasePublicationLock(root, buildLock, token);
    } catch (error) {
      // CONTENTION ON THE CANONICAL PATH IS NOT ACQUISITION FAILING. IT IS
      // ACQUISITION NOT HAVING HAPPENED YET.
      //
      // `EEXIST` was the only contention this loop recognised, and on Windows
      // it is one of three faces of the same moment. A directory another
      // process has deleted, or is deleting, answers differently depending on
      // exactly where in its lifetime a call lands:
      //
      //   mkdir      EEXIST while it is there; EPERM while it sits in
      //              pending-delete with a handle still open. `existsSync`
      //              cannot tell that state from absence — `stat` fails for it
      //              too — so it is recognised by persistence, not by a probe.
      //   write      ENOENT once it is gone.
      //   rename     EPERM when it goes during the owner publish.
      //
      // CI run `33502986214` showed the second; hammering the window locally
      // produced the other two. All three mean the same thing — this process
      // does not hold the lock — and all three used to be thrown straight out
      // of `bin/fiscus.mjs`, killing `fiscus --help` while two builds were
      // publishing. The launcher is right that a lock FAILURE is fatal. None of
      // these is one.
      const code = error?.code;
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(code);

      if (created) {
        // The directory was made and the owner record never landed — and the
        // owner record is what makes the lock ours. This process holds nothing.
        //
        // Deliberately NO cleanup here. The old catch quarantined `buildLock`
        // by pathname to tidy up after itself, which is unsound precisely at
        // this point: nothing proves the directory now at that path is still
        // the one we made. Removing it takes a fresh lock away from another
        // process inside ITS own owner-write window and propagates the failure
        // onward — one lost race cascading through every contender. A directory
        // we really did abandon carries no owner, and the stale path exists for
        // exactly that.
        if (code !== 'ENOENT' && !transient) throw error;
        unusableSince = null;
      } else if (code === 'EEXIST') {
        unusableSince = null;
        const snapshot = inspectLock(buildLock);
        if (lockIsStale(buildLock, snapshot) && quarantineStaleLock(root, buildLock, snapshot)) continue;
      } else if (transient) {
        // Absorb it briefly. A pending delete clears in milliseconds; a
        // read-only parent never will, and deserves its own error rather than a
        // wait-timeout message that names the wrong problem.
        unusableSince ??= Date.now();
        if (Date.now() - unusableSince > PATH_CONTENTION_MS) throw error;
      } else {
        // ENOENT here means the parent directory does not exist. That is not
        // contention with anything.
        throw error;
      }

      if (Date.now() - waitStarted >= LOCK_WAIT_MS) {
        throw new Error(`timed out waiting for another Fiscus build (${LOCK_WAIT_MS}ms)`);
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

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
  const buildLock = join(root, '.fiscus-build.lock');
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
      renameSync(ownerTemp, join(buildLock, OWNER_FILE));

      return () => releasePublicationLock(root, buildLock, token);
    } catch (error) {
      if (created) {
        // mkdir succeeded, so this process owns the not-yet-published lock.
        // Still clean it through quarantine: a direct recursive removal would
        // turn an exceptional owner-record write into another TOCTOU window.
        const snapshot = inspectLock(buildLock);
        if (snapshot && (!snapshot.owner || snapshot.owner.token === token)) {
          if (snapshot.owner) quarantineKnownLock(root, buildLock, snapshot);
          else quarantineUnknownLock(root, buildLock);
        }
      }
      if (error?.code !== 'EEXIST') throw error;

      const snapshot = inspectLock(buildLock);
      if (lockIsStale(buildLock, snapshot) && quarantineStaleLock(root, buildLock, snapshot)) continue;
      if (Date.now() - waitStarted >= LOCK_WAIT_MS) {
        throw new Error(`timed out waiting for another Fiscus build (${LOCK_WAIT_MS}ms)`);
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

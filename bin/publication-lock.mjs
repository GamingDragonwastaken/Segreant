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
/**
 * How long an owner-less runtime-snapshot tree is left before it is reaped.
 *
 * This constant is now the SNAPSHOT reaper's, not the lock's — see
 * `bin/runtime-snapshot.mjs`. The two once shared it because they share a
 * shape (owner-bearing objects judged by PID liveness, owner-less ones by age),
 * but not a cost: nothing waits on a snapshot tree, so a generous grace there
 * only leaves a directory on disk a while longer. Waiting is exactly what the
 * lock does, which is why it needed its own, much shorter budget.
 */
export const LOCK_STALE_MS = 10 * 60_000;
/**
 * How long a lock carrying no owner token in any form is treated as live.
 *
 * Reaching that state means a creator died inside a one-syscall window, so the
 * grace only has to exceed that. It must stay well under `LOCK_WAIT_MS`: at ten
 * minutes it exceeded the wait, and a single such directory wedged every
 * contender until each one timed out.
 */
export const OWNERLESS_LOCK_STALE_MS = 10_000;
export const LOCK_POLL_MS = 25;
export const RENAME_RETRY_MS = 5_000;
/**
 * How long a canonical-path filesystem error is tolerated before it is reported
 * as itself.
 *
 * Contention clears in milliseconds; a full disk or a read-only tree never does,
 * and must be reported as what it is rather than as a wait timeout naming the
 * wrong problem. The budget only has to exceed a plausible run of interference
 * while staying far below `LOCK_WAIT_MS`, so it is generous on purpose.
 */
export const PATH_CONTENTION_MS = 10_000;
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

  // The timer governs ONE case: a directory carrying no token at all, in any
  // form — no owner.json, no `.owner-<token>.tmp`, no quarantined record.
  // `inspectLock` recovers a token from all three, so reaching here means the
  // creator died between `mkdir` and its first write. That window is a single
  // syscall wide, and `LOCK_STALE_MS` (ten minutes) was calibrated for a
  // different question: it is longer than `LOCK_WAIT_MS`, so one such directory
  // parked every contender until they each timed out. An owner-bearing lock is
  // still judged by whether its process is alive, which is the case that
  // legitimately lasts minutes.
  return Date.now() - snapshot.lockStat.mtimeMs > OWNERLESS_LOCK_STALE_MS;
}

/**
 * Is this lock one we created and failed to publish?
 *
 * The token is the proof. A directory carrying OUR token is ours whatever state
 * it is in, and reclaiming it is sound; a directory carrying no token, or
 * someone else's, is not ours to touch. The old cleanup acted on the ABSENCE of
 * a token, which is the one thing that proves nothing.
 */
function ownedByToken(snapshot, token) {
  return snapshot?.owner?.token === token;
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
    // has aged past `OWNERLESS_LOCK_STALE_MS`); a live/uncertain generation is
    // preserved for a later acquisition rather than deleted by pathname.
    //
    // Shortening that timer does not endanger an in-progress quarantine:
    // `quarantineKnownLock` moves the token-bearing record INTO the directory
    // before renaming the directory aside, so a quarantine it is still working
    // on always carries a token and is judged by whether that process is alive.
    // Reaching the timer here means a `quarantineUnknownLock` died partway and
    // left a directory that never had an owner — garbage, and the sooner the
    // better.
    if (lockIsStale(path, snapshot)) removeQuarantine(path);
  }
}

function sameOwner(left, right) {
  return left?.pid === right?.pid && left?.token === right?.token;
}

/**
 * Claim `source` as `target` by rename. Answers whether the claim succeeded.
 *
 * THE ERRNO LIST LIVED HERE TOO. D-072 removed an enumeration of platform error
 * codes from the acquire loop on the grounds that the list is a property of
 * whichever kernel the job runs on, and the next platform adds an entry. It did
 * not remove this one, and macOS supplied the entry: renaming inside a
 * directory a contender has just unlinked answers `EINVAL`, which was not on
 * the list, so it was rethrown — out of `releasePublicationLock`, out of
 * `bin/fiscus.mjs`, killing a CLI that had merely lost a race.
 *
 * The position argument is the same one. This function answers ONE question —
 * did I manage to claim this by rename? — and every caller handles `false` by
 * carrying on. There is no failure here that means "you claimed it", so no
 * failure needs to be fatal. `ENOENT` and `EEXIST` are still distinguished, and
 * not because of what they are called: both mean another process has already
 * settled this claim, so retrying cannot change the answer. Everything else is
 * the path being momentarily unusable, which is what the budget is for.
 *
 * A permanently broken filesystem now returns `false` after `RENAME_RETRY_MS`
 * rather than throwing its exact errno. That is a real loss of diagnostic
 * precision, and it is the right trade: acquisition still surfaces a persistent
 * fault through `PATH_CONTENTION_MS`, and no lock helper should be able to kill
 * the launcher over an errno nobody enumerated.
 */
function renameForQuarantine(source, target) {
  const started = Date.now();
  while (true) {
    try {
      renameSync(source, target);
      return true;
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT' || code === 'EEXIST') return false;
      if (Date.now() - started >= RENAME_RETRY_MS) return false;
      sleep(LOCK_POLL_MS);
    }
  }
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
  if (!renameForQuarantine(buildLock, quarantine)) {
    // A RELEASE THAT GIVES UP DOES NOT LEAVE THE LOCK ALONE. IT LEAVES IT HELD.
    //
    // This was `return`, and that is the most expensive line in the file. By
    // here the owner record has ALREADY been renamed to `.owner-quarantine.json`
    // — so returning leaves the canonical directory in place, carrying a
    // token-bearing record that `inspectLock` reads as an owner and
    // `lockIsStale` then clears as live, because the process it names is this
    // one and this one is still running. The lock is abandoned and permanently
    // un-recoverable: every contender waits out `LOCK_WAIT_MS` and reports
    // `timed out waiting for another Fiscus build`, naming a build that has
    // long since moved on. Observed directly — the repository root held
    // `.owner-quarantine.json` for a live PID across a full minute while
    // `build-race` timed out behind it.
    //
    // The directory rename fails for a reason that has nothing to do with
    // ownership: on Windows a single open handle anywhere inside the directory
    // — another contender mid-`readdirSync`, an indexer, a virus scanner — is
    // enough, and `RENAME_RETRY_MS` is five seconds.
    //
    // Removing it in place is sound HERE and nowhere else. The whole point of
    // claiming the owner record first is that the claim is exclusive: the
    // rename of `owner.json` succeeded and the moved record still carries our
    // token, so this generation is ours and no other process can be inside it.
    // That is the same proof the move itself relies on — the move only buys
    // speed, getting the canonical path free sooner. Losing the speed is not a
    // reason to keep the lock.
    removeQuarantine(buildLock);
    return;
  }
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
      // `EEXIST` was the only contention this loop recognised, and it is one
      // face of the condition among several. The lock is made in two steps —
      // `mkdir` the directory, then write an owner record into it — and between
      // them it carries no owner, which is indistinguishable from one an
      // interrupted process abandoned. A contender that removes it there leaves
      // the creator's write failing, and what that failure is CALLED depends on
      // the platform and on exactly when the call lands:
      //
      //   Windows   EEXIST from mkdir while it is there, EPERM from mkdir while
      //             it sits in pending-delete, ENOENT from the write once it is
      //             gone, EPERM from the rename if it goes mid-publish.
      //   macOS     EINVAL from the write into an unlinked directory.
      //
      // CI showed ENOENT (run `33502986214`), then EINVAL on a different runner
      // (run `33505785655`) once the first three were handled. Enumerating
      // errnos is the wrong shape of fix: the list is a property of the kernel
      // this happens to run on, and the next platform adds another entry.
      //
      // The structural fact does not vary. THE OWNER RECORD IS WHAT MAKES THE
      // LOCK OURS, so if we created the directory and failed to publish that
      // record, we hold nothing — whatever the failure was called. There is no
      // error in that position that means "you hold the lock". So the branch
      // asks where it failed, not what the error was, and a persistent failure
      // is separated from a transient one by whether it clears.
      const code = error?.code;

      if (created) {
        // Clean up ONLY what carries our token. The original code quarantined
        // `buildLock` by pathname, which is unsound here: our owner record never
        // landed, so a pathname says nothing about whose directory it now is,
        // and removing it takes a fresh lock from another process inside ITS own
        // publish window. Removing the cleanup entirely was worse in a different
        // way — a half-written `.owner-<token>.tmp` of OUR OWN is recovered by
        // `inspectLock` as a live owner whose PID is this very process, so the
        // next lap sees a lock owned by someone alive and waits for itself until
        // `LOCK_WAIT_MS`. CI deadlocked eight contenders that way.
        //
        // The token settles it. A directory carrying our token is ours whatever
        // state it is in; one carrying another token, or none, is not ours to
        // touch. `quarantineKnownLock` re-verifies the record after moving it,
        // so a generation that changed under us is restored rather than removed.
        const snapshot = inspectLock(buildLock);
        if (ownedByToken(snapshot, token)) quarantineKnownLock(root, buildLock, snapshot);

        unusableSince ??= Date.now();
        if (Date.now() - unusableSince > PATH_CONTENTION_MS) throw error;
      } else if (code === 'EEXIST') {
        // Someone holds it, or is publishing it. This is the ordinary wait and
        // must not be bounded by the contention budget: a legitimately held lock
        // can outlast it by minutes, and `LOCK_WAIT_MS` is its bound.
        unusableSince = null;
        const snapshot = inspectLock(buildLock);
        // Our own orphan from an earlier lap. Waiting on it is waiting on this
        // process, which never ends: `lockIsStale` asks whether the owner's PID
        // is alive, and for our own token the answer is always yes.
        if (ownedByToken(snapshot, token)) {
          if (quarantineKnownLock(root, buildLock, snapshot)) continue;
        } else if (lockIsStale(buildLock, snapshot) && quarantineStaleLock(root, buildLock, snapshot)) {
          continue;
        }
      } else if (code === 'ENOENT') {
        // `mkdir` cannot answer ENOENT because of anything happening at the lock
        // path itself; the parent directory is missing. Nothing to wait for.
        throw error;
      } else {
        // The path is momentarily unusable — most often a directory another
        // process is deleting. Absorb it while it clears.
        unusableSince ??= Date.now();
        if (Date.now() - unusableSince > PATH_CONTENTION_MS) throw error;
      }

      if (Date.now() - waitStarted >= LOCK_WAIT_MS) {
        throw new Error(`timed out waiting for another Fiscus build (${LOCK_WAIT_MS}ms)`);
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

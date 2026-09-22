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
/**
 * How long release keeps trying the atomic hand-back before removing the lock
 * in place.
 *
 * It only has to outlast transient interference — an open handle, a competing
 * reader mid-scan. It must stay far below `LOCK_WAIT_MS`, because everything
 * queued behind this lock is waiting for exactly this budget to expire.
 */
export const RELEASE_BUDGET_MS = 15_000;
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

/**
 * The token-bearing temp names a creator may have left behind.
 *
 * Shared by `inspectLock`, which reads them as a recoverable identity, and by
 * the release abandon path, which removes them. Those two must agree on what
 * counts as a record: a name one of them recognises and the other does not is
 * exactly how a lock becomes unrecoverable while looking clean.
 */
function ownerTempNames(lockPath) {
  try {
    return readdirSync(lockPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.owner-[0-9a-f-]+\.tmp$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
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
  for (const name of ownerTempNames(buildLock)) {
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

/**
 * Tokens this process is holding RIGHT NOW, as opposed to has ever minted.
 *
 * `ownedByToken` proves a generation is ours. This proves we are still standing
 * in it, and the difference is the whole of D-085: a record naming our PID
 * under a token that is not in here was written by a call that has already
 * returned, so it is an orphan we may reclaim; one under a token that IS in
 * here is a lock we hold, and reclaiming it would hand the same lock to two
 * holders at once.
 */
const heldTokens = new Set();

/**
 * Can whoever owns this generation still do anything with it?
 *
 * ONE QUESTION, ONE ANSWER, ASKED FROM TWO PLACES. The acquire path and the
 * quarantine reaper both need it, and answering it as `processIsAlive` alone
 * gets our own released generations wrong in both: a token this process has
 * already handed back names nobody who will ever come back for it, however
 * alive the PID is. Leaving the reaper on the older answer would repeat D-078
 * exactly — a rule corrected in one place and left standing in the helper next
 * door.
 *
 * For another process, liveness is all we can observe. For ourselves we know
 * something stronger and cheaper: whether we are still standing in it.
 */
function ownerCanStillAct(snapshot) {
  if (!snapshot?.owner) return false;
  if (snapshot.owner.pid === process.pid) return heldTokens.has(snapshot.owner.token);
  return processIsAlive(snapshot.owner.pid);
}

function lockIsStale(buildLock, snapshot = inspectLock(buildLock)) {
  if (!snapshot) return true;
  if (snapshot.owner) return !ownerCanStillAct(snapshot);

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

/**
 * Is this lock owned by the process asking?
 *
 * PID rather than token, deliberately. `lockIsStale` judges an owner by whether
 * its process is alive, which for our own PID is permanently true — so a lock
 * naming us is the one lock in the world this process must never wait for,
 * whatever generation it belongs to.
 *
 * A record naming our PID was written either by this process or by a dead one
 * whose PID we inherited, and reclaiming is correct under both readings: in the
 * first it is our own orphan, in the second its owner is demonstrably gone.
 * `heldTokens` separates out the only case where it is not.
 */
function ownedByThisProcess(snapshot) {
  return snapshot?.owner?.pid === process.pid && Boolean(snapshot.ownerPath);
}

/**
 * May this quarantined generation be collected?
 *
 * NOT `lockIsStale`, WHICH ANSWERS A DIFFERENT QUESTION. That one answers "may
 * I take this canonical lock?", and only half of its answer transfers here. The
 * owner half does: an owner who cannot still act is gone wherever its directory
 * sits, and `ownerCanStillAct` stays the single answer to that so the reaper
 * and the acquire path cannot drift apart — the D-078 lesson.
 *
 * The owner-LESS half does not transfer. `lockIsStale` gives an owner-less
 * directory `OWNERLESS_LOCK_STALE_MS` for the reason its own comment states:
 * the creator may have died "between `mkdir` and its first write", so the timer
 * protects a live process about to write its record into a directory it has
 * just made. No such process can exist at a quarantine pathname. A quarantine
 * is only ever created by RENAMING an existing directory aside; nothing is ever
 * `mkdir`ed there, and no creator will ever come back for a name it does not
 * know. An owner-less quarantine is therefore garbage the instant it exists,
 * and the timer protected nobody while delaying its collection.
 *
 * That delay was a real failure, not a tidiness point. `quarantineKnownLock`
 * renames whatever is at the canonical path at the instant it acts, which need
 * not be the generation it inspected — a contender can quarantine and remove
 * that generation while a third process `mkdir`s a fresh empty one. The
 * mismatch is detected and restoration attempted; when the canonical path has
 * already been re-claimed, restoration loses the race D-092 recorded, and an
 * EMPTY quarantine is left behind. Run `33760552077` failed on Ubuntu and
 * Windows both because a sweeping acquisition could not collect it for ten
 * seconds.
 *
 * Racing a quarantine still in progress is safe under this rule. The two paths
 * that create one from an owner-bearing directory (`quarantineKnownLock`,
 * `releaseOwnedGeneration`) move the token-bearing record INTO the directory
 * first, so what they are working on always carries a record and is judged by
 * liveness. The one path that quarantines an owner-less directory
 * (`quarantineUnknownLock`) is itself about to delete it, and `removeQuarantine`
 * swallows the loss.
 */
function quarantineIsCollectable(snapshot) {
  if (!snapshot) return true;
  if (snapshot.owner) return !ownerCanStillAct(snapshot);
  return true;
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
    if (quarantineIsCollectable(inspectLock(path))) removeQuarantine(path);
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

/**
 * Put a quarantined generation back, if the canonical path is still free.
 *
 * THE ERRNO LIST WAS STILL HERE, AND LINUX SUPPLIED THE NEXT ENTRY. The comment
 * on `renameForQuarantine` above records D-072 removing an enumeration of
 * platform error codes "on the grounds that the list is a property of whichever
 * kernel the job runs on, and the next platform adds an entry", and notes that
 * it did not remove this one. This function kept
 * `['ENOENT','EACCES','EBUSY','EPERM','EEXIST']` and rethrew everything else.
 * Renaming a directory onto an existing NON-EMPTY directory answers `EEXIST` on
 * Windows and `ENOTEMPTY` on Linux — POSIX permits either — so the list was
 * complete on the platform it was written on and wrong on the one CI runs.
 * Exact-head run `33730517441` killed a worker inside `acquirePublicationLock`
 * with a raw `ENOTEMPTY` for losing a race it is designed to lose.
 *
 * THE POSITION, NOT THE ENTRY. Adding `ENOTEMPTY` would repeat the mistake with
 * one more name. The reason no failure here may be fatal is structural: once
 * `renameForQuarantine` moved the lock aside, THE CANONICAL PATH IS ABSENT and
 * any contender may claim it immediately. So restoration is best-effort by
 * construction — a failure means somebody else got there first, which is the
 * ordinary outcome of a lost race and never a reason to kill a build. Both
 * callers already ignore the answer and return `false` regardless; there is no
 * failure here that means "you restored it".
 *
 * WHAT IS PRESERVED. A failed restore still never deletes the quarantine to make
 * the error disappear. The generation is left intact for `reapOrphanQuarantines`,
 * which collects it once its owner is demonstrably dead — by owner token, never
 * by pathname.
 */
function restoreQuarantinedLock(buildLock, quarantine) {
  try {
    renameSync(quarantine, buildLock);
    return true;
  } catch {
    return false;
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

/**
 * Hand back a lock this process proved it owns.
 *
 * THE INVARIANT, WHICH THE OLD SHAPE VIOLATED FOUR WAYS.
 *
 *   A process that cannot prove it owns the lock must never act as though it
 *   does, and a process that HAS proved ownership must not return while
 *   leaving that lock permanently held.
 *
 * Release used to be a straight line of atomic steps, each of which returned on
 * failure. Three of those returns left the canonical directory in place still
 * carrying OUR token — and `inspectLock` reads that record as an owner while
 * `lockIsStale` clears it as live, because the PID it names is this process and
 * this process is still running. No contender can ever recover such a lock:
 * they wait out `LOCK_WAIT_MS` and report `timed out waiting for another Fiscus
 * build` about a build that moved on minutes earlier.
 *
 * D-077 fixed ONE of those four returns — the directory move — and did not ask
 * about its siblings. That is the same mistake D-078 found in the acquire path
 * (an errno list removed in one place and left in the helper next door), which
 * makes it the defect CLASS rather than an unlucky line. So the give-up
 * decision is no longer per-step at all: the loop below re-establishes whether
 * the lock is still ours and keeps trying, and the only way out is that the
 * lock is gone, or demonstrably not ours, or removed by us.
 *
 * THE TERMINAL FALLBACK IS SOUND ONLY BECAUSE OF THE TOKEN. Removing the
 * directory by pathname is exactly what the atomic dance exists to avoid, and
 * it is safe here for one reason: `ownedByToken` has just re-read the lock and
 * found OUR token in it. That is the same proof every other step relies on. The
 * quarantine rename only ever bought speed — freeing the canonical path sooner
 * — and losing speed is not a reason to keep a lock forever.
 */
function releasePublicationLock(root, buildLock, token) {
  // Dropped FIRST, and on every exit below by virtue of being dropped here: a
  // token left in the set after release would make a later acquisition treat a
  // genuine orphan of ours as a lock we are standing in, and refuse instead of
  // reclaiming. Release is the moment we stop standing in it, whatever the
  // filesystem then does.
  heldTokens.delete(token);

  const deadline = Date.now() + RELEASE_BUDGET_MS;
  while (true) {
    const snapshot = inspectLock(buildLock);
    // Gone, or a newer generation someone else owns. We hold nothing, and
    // touching it would be the pathname-based cleanup D-072 removed.
    if (!ownedByToken(snapshot, token) || !snapshot.ownerPath) return;

    if (releaseOwnedGeneration(root, buildLock, token, snapshot)) return;

    if (Date.now() >= deadline) {
      abandonOwnedGeneration(buildLock, token);
      return;
    }
    sleep(LOCK_POLL_MS);
  }
}

/**
 * Take back a canonical lock that names this process, at any cost.
 *
 * The acquire-side twin of `releasePublicationLock`, and it exists for the same
 * reason: waiting is not one of the outcomes. `abandonOwnedGeneration` is the
 * same terminal step, licensed by the same proof — the owner record names our
 * PID, and while we are alive no contender can have taken this generation,
 * because a contender only touches a live lock it does not own after judging
 * the owner dead.
 *
 * The atomic route is tried first and given the same budget release gets, so a
 * rename losing to momentary contention is retried rather than escalated. Past
 * it, the directory goes. Degrading the canonical path to owner-less — which
 * `OWNERLESS_LOCK_STALE_MS` clears in ten seconds — is a real outcome. Waiting
 * five minutes for ourselves is not an outcome at all.
 */
function reclaimOwnGeneration(root, buildLock, snapshot, ownedSince) {
  if (quarantineKnownLock(root, buildLock, snapshot)) return true;
  if (Date.now() - ownedSince < RELEASE_BUDGET_MS) return false;
  abandonOwnedGeneration(buildLock, snapshot.owner.token);
  return true;
}

/**
 * Last resort: make this generation recoverable by someone else, at any cost
 * short of touching a generation that is not ours.
 *
 * Reached only after `ownedByToken` has just re-read the lock and found OUR
 * token in it. That proof is what licenses acting by pathname here: the token
 * is a UUID minted in this process, so the directory is demonstrably our
 * generation, and while this process is alive no other can have taken it — a
 * contender only touches a live lock it does not own by first judging the owner
 * dead, and `processIsAlive` says otherwise about us.
 *
 * Two attempts, because the first one can be swallowed:
 *
 *   1. Remove the directory. Best outcome — the canonical path is free at once.
 *   2. If it is still ours, unlink every token-bearing record inside it. What
 *      makes a lock look HELD is the record, not the directory: without one,
 *      `inspectLock` reports an owner-less lock and `lockIsStale` clears it on
 *      the `OWNERLESS_LOCK_STALE_MS` timer.
 *
 * Step 2 is the reason this is a function rather than one call. `rmSync` is not
 * atomic and `removeQuarantine` swallows its failures by design, so a partial
 * removal that leaves the owner record behind would put us straight back into
 * the permanently-held state this whole path exists to prevent. Degrading to
 * "recoverable in ten seconds" is a real outcome; returning while holding it
 * forever is not an outcome at all.
 */
function abandonOwnedGeneration(buildLock, token) {
  removeQuarantine(buildLock);
  if (!ownedByToken(inspectLock(buildLock), token)) return;

  for (const name of [OWNER_FILE, ...ownerQuarantineNames(buildLock), ...ownerTempNames(buildLock)]) {
    try {
      rmSync(join(buildLock, name), { force: true, maxRetries: 20, retryDelay: LOCK_POLL_MS });
    } catch {
      // Nothing further is available. The next acquisition inspects it again.
    }
  }
}

/**
 * One attempt at the atomic hand-back. Answers whether the lock is now gone.
 *
 * Every `false` here means "could not finish this time", never "give up" — the
 * caller decides that, against the invariant, and it is the caller that owns
 * the fallback. Keeping the steps atomic still matters: a pathname read
 * followed by recursive deletion would race a lock that changed underneath us,
 * and the fallback is only reached after that race has been re-checked.
 */
function releaseOwnedGeneration(root, buildLock, token, snapshot) {
  const ownerName = OWNER_QUARANTINE_FILE;
  const ownerQuarantine = join(buildLock, ownerName);
  if (snapshot.ownerPath !== ownerQuarantine && !renameForQuarantine(snapshot.ownerPath, ownerQuarantine)) {
    return false;
  }
  const movedOwner = readOwnerFile(ownerQuarantine);
  if (!movedOwner || movedOwner.token !== token) {
    // The record changed under us, so this generation may not be ours after
    // all. Put it back and let the caller re-establish ownership from scratch.
    try { renameSync(ownerQuarantine, snapshot.ownerPath); } catch { /* the next lap re-reads it */ }
    return false;
  }

  const quarantine = join(root, `${LOCK_QUARANTINE_PREFIX}release-${process.pid}-${randomUUID()}`);
  if (!renameForQuarantine(buildLock, quarantine)) return false;

  const quarantinedOwner = readOwnerFile(join(quarantine, ownerName));
  if (!quarantinedOwner || quarantinedOwner.token !== token) {
    restoreQuarantinedLock(buildLock, quarantine);
    return false;
  }
  removeQuarantine(quarantine);
  return true;
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
  // First moment the canonical lock was seen carrying THIS process's PID under
  // a token we are not holding. Reset whenever it is not, so the budget bounds
  // a consecutive run rather than a total.
  let ownedSince = null;
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

      heldTokens.add(token);
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
        // A LOCK NAMING THIS PROCESS IS NEVER SOMETHING TO WAIT FOR.
        //
        // This test used to be `ownedByToken`, and the token is minted per CALL
        // — so a generation left behind by an EARLIER call of this same process
        // carried a token this call had never heard of. Different token, live
        // PID: not ours to reclaim by that test, not stale by `lockIsStale`,
        // and therefore waited on until `LOCK_WAIT_MS`. CI run `33630894290`
        // killed a contender at the harness window with every other worker long
        // since exited, which leaves exactly one process alive to have owned it.
        //
        // The actor is the right granularity, not the generation. What made
        // waiting futile was never the token — it was that the PID we are
        // waiting on is our own, and `processIsAlive` will keep saying yes for
        // as long as we are the one asking.
        if (ownedByThisProcess(snapshot)) {
          if (heldTokens.has(snapshot.owner.token)) {
            // Not an orphan: we are standing in this lock. Reclaiming would
            // hand one lock to two holders, and waiting is a deadlock with a
            // five-minute fuse that then blames another build for it.
            throw new Error('publication lock is already held by this process; release it before acquiring again');
          }
          ownedSince ??= Date.now();
          if (reclaimOwnGeneration(root, buildLock, snapshot, ownedSince)) continue;
        } else {
          ownedSince = null;
          if (lockIsStale(buildLock, snapshot) && quarantineStaleLock(root, buildLock, snapshot)) continue;
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

# The publication lock as a state machine

`bin/publication-lock.mjs` is the cross-process gate every build and every CLI
launch passes through. It has been repaired six times, and five of those repairs
were made by looking at the line that appeared in a failing stack trace. This
document exists because that method kept producing correct local fixes that left
the same defect standing next door — D-072 removed an errno list from the
acquire loop and left an identical one in `renameForQuarantine` (D-078); D-077
fixed one give-up path in release and left three siblings (D-080).

So the protocol is written out here as states and transitions, and the code is
judged against it rather than against the last stack trace.

## The governing invariant

> A process that cannot prove it owns the lock must never act as though it does,
> and a process that has proved ownership must not terminate or return while
> leaving that lock permanently held.

Both halves have teeth. The first forbids acting by pathname — the defect class
D-072 named. The second forbids the tidy-looking `return` — the defect class
D-077 and D-080 named. Every transition below is checked against both.

## What proves ownership

Not the pathname, and not the absence of someone else's record. **The token.**
`acquirePublicationLock` mints a `randomUUID()` per attempt and writes it into
the owner record. `ownedByToken(snapshot, token)` is the only ownership proof in
the module, and it is what licenses every destructive act.

The token is also what makes the terminal fallback in `abandonOwnedGeneration`
sound rather than reckless: removing a directory by pathname is exactly what the
atomic dance exists to avoid, and it is safe there *only* because `inspectLock`
has just re-read the directory and found this process's UUID inside it.

## States

A state is an *observable configuration* — what `inspectLock` can prove about
the canonical path from outside. It is deliberately not "what the owning process
intended", because no other process can see that.

| State | Observable | Recovered by |
| --- | --- | --- |
| `ABSENT` | no `.fiscus-build.lock` | n/a — acquirable |
| `CREATED_OWNERLESS` | directory present, no valid record in any form | age > `OWNERLESS_LOCK_STALE_MS` (10s) |
| `TEMP_OWNER_WRITTEN` | `.owner-<token>.tmp` parses; no `owner.json` | owner PID liveness |
| `OWNED` | `owner.json` parses | owner PID liveness |
| `OWNER_QUARANTINED` | `.owner-quarantine.json` parses; no `owner.json` | owner PID liveness |
| `DIRECTORY_QUARANTINED` | canonical path free; `.fiscus-build.lock.quarantine-*` at the root | `reapOrphanQuarantines` on the next acquisition |
| `RELEASED` | the generation is gone | n/a — terminal |

Two structural notes, both load-bearing:

**A partially written record is not a state.** `readOwnerFile` requires parseable
JSON with a positive integer `pid` and a non-empty string `token`. A half-written
temp therefore reads as `null`, so a directory mid-write is observably
`CREATED_OWNERLESS` and not something in between. The states are what can be
*proved*, which is why there is no torn-record case to reason about.

**`ORPHANED` is not a state; it is a predicate over states.** `lockIsStale`
layers a judgement about the OWNER on top of `CREATED_OWNERLESS`,
`TEMP_OWNER_WRITTEN`, `OWNED`, `OWNER_QUARANTINED` and `DIRECTORY_QUARANTINED`.
The question it asks is not "is that process alive" but `ownerCanStillAct` —
*can whoever owns this still do anything with it* — and the two differ in
exactly one case:

- owner PID is another process → can act iff `processIsAlive(pid)`
- owner PID is **this** process → can act iff its token is in `heldTokens`,
  which is to say iff we are still standing in that generation. A token we have
  already handed back names nobody who will ever come back for it, however alive
  the PID is.
- carries no token at all → orphaned iff older than `OWNERLESS_LOCK_STALE_MS`

That middle rule is D-085 and it did not exist in the first version of this
model. Writing `ORPHANED` as a peer of the other states hides the thing that
matters, which is the next section.

## The unreachable state, which is the whole defect class

Every recovery rule keys on **death**. Nothing keys on **abandonment**.

So consider a lock in `OWNED` or `OWNER_QUARANTINED` whose owner PID is alive
but has stopped acting on it — because release gave up and returned. Call it
`HELD_BY_ABANDONER`. It satisfies no staleness rule: `processIsAlive` says the
owner is there. It is not on any timer: timers only govern token-less
directories. **No transition out of it exists.** Contenders wait the full
`LOCK_WAIT_MS` and then report `timed out waiting for another Fiscus build`
about a build that finished minutes earlier — which is precisely the message CI
run `33507233437` produced (**failure**, ubuntu/macOS/candidate-head), and
precisely why it named the wrong problem.

This state cannot be fixed by recovery **from outside**, because a contender has
nothing to key on. It has to be made unreachable at the source: the process that
would abandon it must not be permitted to return while it is still theirs. That
is the entire justification for the loop in `releasePublicationLock` and the
terminal fallback in `abandonOwnedGeneration` — not a patch on a bad line, but
the transition that deletes a state from the machine.

### The second route in, and the sentence above that was too strong

That analysis closed the release route and stopped there, and the state came
back through the door next to it. CI run `33630894290` (**failure**,
ubuntu/macOS/candidate-head) killed one of four contenders at the harness's 180s
window with every other worker long since exited — which leaves exactly one
process alive that could have owned what it was waiting for. Itself.

The acquire loop already knew that waiting on its own generation never ends, and
guarded it with `ownedByToken`. **But the token is minted per CALL.** A
generation left by an earlier `acquirePublicationLock` in the same process
carries a token this call has never heard of, so the guard does not fire; and
`lockIsStale` clears the owner as live, because the PID it names is ours. Not
ours by that test, not stale by this one, and therefore waited on for
`LOCK_WAIT_MS` — `HELD_BY_ABANDONER` again, reached from acquire instead of
release.

**The generation was the wrong granularity. The actor is the right one.** What
made waiting futile was never which token the record carried; it was that the
PID being waited on is the PID doing the waiting, and `processIsAlive` keeps
saying yes for as long as we are the one asking. So the acquire path now tests
`ownedByThisProcess` — PID, not token — and splits on `heldTokens`:

- token **not** held → our own orphan. Reclaim it: `quarantineKnownLock` first,
  and past `RELEASE_BUDGET_MS` the same terminal `abandonOwnedGeneration` the
  release path uses, licensed by the same proof.
- token **is** held → we are standing in this lock, and this is a re-entrant
  acquisition. Reclaiming would hand one lock to two holders; waiting is a
  deadlock with a five-minute fuse that then blames another build for it. It
  throws, at the call.

And the claim that there is "nothing for a recoverer to key on" was too strong.
It is true for a contender, which can observe only liveness. It is false for the
abandoner, which knows something a contender cannot: whether it is still
standing in that generation. `ownerCanStillAct` is that knowledge, stated once
and used by both the acquire path and `reapOrphanQuarantines` — the reaper asks
the identical question, and answering it two different ways in two places is
exactly the shape of D-078.

Measured effect: `ordinary contention leaves no lock residue` fell from ~17-22s
to **4.4s** locally. The wait it used to spend was real, and it was self-inflicted.

## Transitions

Each row answers the questions the audit requires: who acts, what proves the
right to act, whether the operation is atomic, what an observer sees, what
happens if the actor dies on either side of it, what it can do to a *newer*
generation, whether the result is recoverable, and whether it depends on errno.

### T1 `ABSENT` to `CREATED_OWNERLESS` — `mkdirSync(buildLock)`

- **Actor / proof** — any contender; no proof needed, the operation *is* the claim.
- **Atomic** — yes, and exclusive: a second `mkdir` answers `EEXIST`.
- **Observability** — `inspectLock` reports `{ owner: null, ownerPath: null }`.
- **Death before** — nothing happened.
- **Death after** — `CREATED_OWNERLESS` with no token at all. Recoverable only by
  the 10s timer. This is the sole reason that timer exists, and the sole reason
  it must stay far below `LOCK_WAIT_MS`: at the old ten minutes one such
  directory outlasted the wait of everything queued behind it.
- **Newer generations** — cannot affect one; there is none yet.
- **Errno** — `EEXIST` is load-bearing *as the outcome of one atomic operation*,
  which is legitimate. That is categorically different from diagnosing a
  compound failure by its name, which is what D-072 and D-078 removed.

### T2 `CREATED_OWNERLESS` to `TEMP_OWNER_WRITTEN` — `writeFileSync(.owner-<token>.tmp)`

- **Actor / proof** — the creator, holding the directory it just made.
- **Atomic** — no. Mitigated by validation, not by locking: a torn file fails
  `readOwnerFile` and the state is observably unchanged (see above).
- **Death after** — `TEMP_OWNER_WRITTEN` carrying our token and a now-dead PID.
  `inspectLock` deliberately recovers the token from the temp name so this is
  judged by PID liveness rather than dumped onto the owner-less timer.
- **Errno** — none. A failure here means the directory went away under us, and
  the `created` branch handles it by **position**: we have not published a
  record, so we hold nothing, whatever the failure was called.

### T3 `TEMP_OWNER_WRITTEN` to `OWNED` — `renameSync(tmp, owner.json)`

- **Atomic** — yes, same-directory rename. Identity is preserved exactly; there
  is no window in which a waiter can see a half-published owner.
- **Death either side** — a token-bearing state with a dead PID. Recoverable.
- **Errno** — none, same reasoning as T2.

### T1–T3 failure to self-reclaim — `inspectLock` + `quarantineKnownLock`

- **Proof** — `ownedByToken(snapshot, token)`. This is the transition D-073
  added and it is not optional: without it, our own abandoned
  `.owner-<token>.tmp` is recovered by `inspectLock` as an owner whose PID is
  *this process*, so the next lap waits for itself until `LOCK_WAIT_MS`. Eight
  CI contenders deadlocked exactly that way.
- **Newer generations** — cannot touch one. The pathname-based version of this
  cleanup (removed by D-072) could and did: it deleted another process's fresh
  lock from inside that process's own publish window.

### T4 `OWNED` to `OWNER_QUARANTINED` — `renameSync(owner.json, .owner-quarantine.json)`

The claim on a generation. Both the owner (release) and a recoverer (stale
recovery) use it, and it is what makes the claim exclusive.

- **Proof** — release: `token` match. Recovery: `lockIsStale` first, then
  `sameOwner` re-verification *after* the move, so a generation that changed
  under us is restored rather than removed.
- **Atomic** — yes. The **fixed** target name is deliberate: it makes the claim
  itself exclusive, so competing recoverers observe one claimed generation
  instead of shuffling one another's uniquely-named records around.
- **Death after** — `OWNER_QUARANTINED`, dead PID → recoverable, because
  `inspectLock` reads quarantined records as an identity.
- **Abandonment after** — `HELD_BY_ABANDONER`. Unrecoverable. This was give-up
  path (b)/(c) of the old release.

### T5 `OWNER_QUARANTINED` to `DIRECTORY_QUARANTINED` — `renameSync(buildLock, .fiscus-build.lock.quarantine-<pid>-<uuid>)`

- **Atomic** — yes, and the target name is unique, which is the point of the
  whole two-step. After it, the canonical path is `ABSENT` and a contender may
  immediately create a fresh generation there — and **nothing we subsequently do
  to the quarantine can affect it**. Cleanup by pathname of the *canonical* path
  can destroy a newer generation; cleanup of a uniquely named quarantine cannot.
- **Death after** — `DIRECTORY_QUARANTINED`, dead PID → `reapOrphanQuarantines`
  collects it at the start of the next acquisition.
- **Errno** — none. `renameForQuarantine` answers one question — did I claim it?
  — and every caller treats `false` as "carry on". There is no failure in this
  position that means "you claimed it", so none needs to be fatal. That is why
  the macOS `EINVAL` (run `33561854121`, **failure** on `test (macos-latest)`)
  could kill a CLI that had merely lost a race, and why the fix was to delete the
  list rather than extend it.

### T6 `DIRECTORY_QUARANTINED` to `RELEASED` — `rmSync(recursive)`

- **Atomic** — no, and it does not need to be. This is the one place where
  swallowing a failure is correct: the object is off the acquisition path, so a
  surviving quarantine costs a directory on disk and nothing else. It is
  collected by `reapOrphanQuarantines` later.

### T7 `DIRECTORY_QUARANTINED` to `OWNED` — `restoreQuarantinedLock`

Taken when the post-move identity check fails, i.e. the generation was not the
one we judged. Rename back; if the canonical path has since been taken, leave
both alone rather than deleting either. Never recursively delete a quarantine to
make an error disappear.

### T8 `OWNED` / `OWNER_QUARANTINED` (ours, live) to `ABSENT` — `abandonOwnedGeneration`

The transition that makes `HELD_BY_ABANDONER` unreachable.

- **Proof** — `ownedByToken` re-read immediately before. While this process is
  alive no other can have taken our generation: a contender only touches a live
  lock it does not own after judging the owner dead, and `processIsAlive` says
  otherwise about us. So the TOCTOU window this appears to open is in fact
  closed by our own liveness.
- **Two attempts** — remove the directory; then, if it is *still* ours, unlink
  every token-bearing record inside it. The second attempt matters because
  `removeQuarantine` swallows failures: a partial removal that left the owner
  record behind would put us straight back into the state this path exists to
  prevent. Stripping the record degrades the lock to `CREATED_OWNERLESS`, which
  clears on the 10s timer. Recoverable-in-ten-seconds is a real outcome; held
  forever is not an outcome at all.

## Timers, and what each one bounds

| Constant | Value | Bounds |
| --- | --- | --- |
| `LOCK_WAIT_MS` | 300s | how long a contender waits for a legitimately held lock |
| `OWNERLESS_LOCK_STALE_MS` | 10s | how long a token-less directory is presumed live |
| `RELEASE_BUDGET_MS` | 15s | how long release tries the atomic hand-back before abandoning |
| `RENAME_RETRY_MS` | 5s | how long one rename absorbs transient interference |
| `PATH_CONTENTION_MS` | 10s | how long a *consecutive* run of canonical-path errors is absorbed before being reported as itself |
| `LOCK_POLL_MS` | 25ms | poll interval |

The ordering constraint is not cosmetic: every timer that gates *recovery* must
sit well below `LOCK_WAIT_MS`, or a recoverable lock outlasts the patience of
everything queued behind it and the failure is reported as a wait timeout naming
a build that does not exist. `OWNERLESS_LOCK_STALE_MS` violated that at ten
minutes, and the test `an owner-less lock cannot outlast the wait that queues
behind it` pins it.

**Raising a timeout is not a repair.** Not one of the six defects was a timer
being too small; every one was a state the machine could enter and not leave.

## What this model does not establish

It is a model of the *protocol*, derived from the source. It does not establish
that the implementation matches it — the tests in
`test/publication-lock-race.test.ts` do that for the transitions they cover, and
they do not cover all of them. Specifically:

- T6 and T7 have no direct test. Both are exercised incidentally by the
  contention test, which asserts on residue rather than on the transition.
- The `HELD_BY_ABANDONER` guard is tested through a *manufactured* permanent
  obstruction (a directory planted at `.owner-quarantine.json`). That is a
  stand-in for the real cause — a transient open handle — chosen because it is
  deterministic. It establishes that release cannot return holding the lock; it
  does not reproduce the interleaving that made release fail in CI.
- Nothing here is evidence about a filesystem the suite has not run on. NFS,
  a container overlay, and a Windows share each make different promises about
  `rename` atomicity, and the model assumes POSIX/NTFS same-directory rename
  semantics throughout.

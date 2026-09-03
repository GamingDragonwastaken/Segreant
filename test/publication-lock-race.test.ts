/**
 * Losing the lock directory before publishing ownership is a lost race.
 *
 * `acquirePublicationLock` creates `.fiscus-build.lock` with `mkdir`, then
 * writes an owner record into it. Between those two steps the directory exists
 * and carries no owner, which makes it indistinguishable from one an
 * interrupted process abandoned. If it is removed in that window, the
 * legitimate creator's `writeFileSync` throws ENOENT.
 *
 * That threw straight out of the CLI. CI run `33502986214` failed
 * `test (windows-latest)` with
 *
 *     Error: ENOENT: ... open '...\.fiscus-build.lock\.owner-<uuid>.tmp'
 *       at acquirePublicationLock (bin/publication-lock.mjs:307)
 *       at bin/fiscus.mjs:53
 *
 * so `fiscus --help` died while two builds were publishing. The launcher is
 * right to treat a lock FAILURE as fatal — bypassing the gate would make a
 * reader's artifact guarantee rest on an unverified filesystem assumption — but
 * this is not a failure. This process did not acquire the lock. It belongs in
 * the wait loop.
 *
 * The second half of the repair matters more than the first. The old catch
 * block, seeing `created === true`, quarantined `buildLock` BY PATHNAME to tidy
 * up after itself. By then the directory is gone, so any directory at that path
 * belongs to someone else — the cleanup took a fresh lock away from another
 * process inside ITS owner-write window and propagated the same ENOENT to it.
 *
 * ENUMERATING ERRNOS WAS THE WRONG SHAPE OF FIX. The first repair listed the
 * three codes Windows produces. Run `33505785655` then failed on macOS with a
 * fourth, EINVAL from writing into an unlinked directory — because the list is a
 * property of the kernel it happens to run on. What does not vary is where the
 * failure happened: the owner record is what makes the lock ours, so a creator
 * that failed to publish one holds nothing, whatever the failure was called.
 *
 * WHAT THESE TESTS ESTABLISH, AND WHAT THEY DO NOT. They manufacture the
 * condition directly: a second process deletes the canonical lock in a tight
 * loop while a contender acquires and releases. That is the state the CI log
 * shows, and it fails on the unrepaired code. It is NOT a reproduction of the
 * interleaving that produced that state in CI, which was never observed — only
 * its signature. So this covers the RESPONSE to a vanished lock directory, and
 * says nothing about what made one vanish under two concurrent builders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_MODULE = pathToFileURL(join(ROOT, 'bin', 'publication-lock.mjs')).href;

/**
 * Run a child, and KILL IT rather than let it hang.
 *
 * Every failure mode in this file ends in `acquirePublicationLock` waiting, and
 * its own bound is `LOCK_WAIT_MS` — five minutes. A deadlocked worker therefore
 * fails the suite five minutes later with `timed out waiting for another Fiscus
 * build`, which names the wrong problem: nothing else held the lock. That is
 * how run `33507233437` reported a self-deadlock, and it cost a CI round to
 * read. A kill window well below that bound turns the same defect into a fast,
 * legible failure that says which worker stopped making progress.
 */
function run(
  script: string,
  args: string[],
  killAfterMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, killAfterMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killed) stderr += `\n[killed after ${killAfterMs}ms without exiting — it stopped making progress]`;
      resolve({ code: killed ? -1 : code ?? 1, stdout, stderr });
    });
  });
}

test('a contender whose own lock directory is removed retries instead of dying', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-race-'));

  // The contender: acquire and release, over and over, for a fixed wall-clock
  // budget. Cycles rather than a count, so a slow machine takes fewer laps
  // instead of turning a timing assumption into a hang.
  const contender = join(dir, 'contender.mjs');
  writeFileSync(contender, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    'let laps = 0;',
    'while (Date.now() < untilMs) {',
    '  const release = acquirePublicationLock(root);',
    '  release();',
    '  laps += 1;',
    '}',
    'process.stdout.write(String(laps));',
  ].join('\n'), 'utf8');

  // The saboteur: delete the canonical lock as fast as the filesystem allows.
  // This is the mkdir-to-owner-write window, entered deliberately rather than
  // waited for. It never touches quarantines, so it cannot mask a cleanup bug.
  const saboteur = join(dir, 'saboteur.mjs');
  writeFileSync(saboteur, [
    "import { rmSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    "const lock = join(root, '.fiscus-build.lock');",
    'while (Date.now() < untilMs) {',
    '  try { rmSync(lock, { recursive: true, force: true }); } catch { /* it may already be gone */ }',
    '}',
  ].join('\n'), 'utf8');

  try {
    const until = Date.now() + 3_000;
    const [a, b, sabotage] = await Promise.all([
      run(contender, [dir, String(until)]),
      run(contender, [dir, String(until)]),
      run(saboteur, [dir, String(until)]),
    ]);

    assert.equal(sabotage!.code, 0, sabotage!.stderr);
    for (const result of [a!, b!]) {
      // The specific regression: ENOENT on our own `.owner-<token>.tmp`,
      // thrown out of `acquirePublicationLock` and out of the process.
      assert.doesNotMatch(
        result.stderr,
        /ENOENT/,
        'a contender threw on a lock directory that was taken from it',
      );
      assert.equal(result.code, 0, result.stderr || 'a lock contender exited non-zero');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('a contender never waits on its own half-published lock', async () => {
  // THE REPAIR'S OWN DEFECT, WHICH IS A DIFFERENT ONE FROM THE DEFECT IT FIXED.
  //
  // Removing the created-branch cleanup (D-072) was right about pathnames and
  // wrong about tokens. `acquirePublicationLock` publishes ownership in two
  // steps — write `.owner-<token>.tmp`, then rename it to `owner.json` — so a
  // failure BETWEEN them leaves our own token-bearing temp inside our own lock
  // directory. `inspectLock` deliberately recovers a token from that temp, and
  // `lockIsStale` then asks whether the owner's process is alive. The owner is
  // this process. It is alive. So the contender waited on itself for the full
  // `LOCK_WAIT_MS` and the suite reported `timed out waiting for another Fiscus
  // build` — naming another build that never existed. Run `33507233437` failed
  // that way on ubuntu and macOS simultaneously.
  //
  // Manufacturing it deterministically needs the rename to fail while the temp
  // SURVIVES, which is the one interleaving the saboteur above cannot produce:
  // it deletes the directory, taking the temp with it. Planting a DIRECTORY at
  // `owner.json` does it exactly — `rename` cannot replace a directory, so the
  // publish fails with the temp still in place, which is the state a
  // mid-publish interruption leaves on a real filesystem.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-self-'));

  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    'let laps = 0;',
    'while (Date.now() < untilMs) {',
    '  acquirePublicationLock(root)();',
    '  laps += 1;',
    '}',
    'process.stdout.write(String(laps));',
  ].join('\n'), 'utf8');

  const saboteur = join(dir, 'saboteur.mjs');
  writeFileSync(saboteur, [
    "import { mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [root, untilMs] = [process.argv[2], Number(process.argv[3])];',
    "const blocker = join(root, '.fiscus-build.lock', 'owner.json');",
    // NOT recursive, deliberately: this must only ever plant the blocker inside
    // a lock directory somebody else already created. Creating the lock itself
    // would squat the path as an owner-less directory and test the staleness
    // timer instead of the thing under test.
    'while (Date.now() < untilMs) {',
    '  try { mkdirSync(blocker); } catch { /* no lock right now, or already planted */ }',
    '}',
  ].join('\n'), 'utf8');

  try {
    // The sabotage window stays well inside PATH_CONTENTION_MS (10s): a run of
    // failures longer than that budget is meant to be reported as a real fault
    // rather than absorbed, and this is contention, not a fault.
    const until = Date.now() + 2_000;
    const [worked, sabotage] = await Promise.all([
      run(worker, [dir, String(until)], 30_000),
      run(saboteur, [dir, String(until)], 30_000),
    ]);

    assert.equal(sabotage!.code, 0, sabotage!.stderr);
    // On the unrepaired code this is the assertion that fires: the worker is
    // still blocked on its own orphaned lock when the kill window closes.
    assert.equal(
      worked!.code,
      0,
      worked!.stderr || 'the contender never returned from acquiring a lock it had abandoned itself',
    );

    // And it must not have solved the problem by abandoning the directory: a
    // surviving generation would mean the reclamation moved on without it.
    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `lock residue left behind: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('ordinary contention leaves no lock residue', async () => {
  // A FIXED CYCLE COUNT MADE THIS A THROUGHPUT MEASUREMENT.
  //
  // It ran eight workers through twenty-five acquisitions each, and every
  // acquisition is serialized behind the others, so the test's wall clock was
  // two hundred times the cost of one critical section. That cost is not small
  // and not ours: releasing renames the owner record aside, renames the lock
  // directory to a quarantine and deletes it, and on Windows those renames
  // measured a 115ms median and a 763ms maximum under this very contention.
  // Timing the module's internals put ~4s of a ~34s run inside
  // `renameForQuarantine` alone, with the reaper and the recursive delete never
  // once exceeding 50ms — so the duration is the release protocol's atomicity,
  // which is the property that makes it safe, rather than a defect to remove.
  //
  // Idle, that was 17-22s. Inside the full suite, with the runner executing
  // other files in parallel, it exceeded a minute. A load-sensitive duration is
  // not something this test is entitled to assert: its claim is that nothing is
  // LEFT BEHIND, and that claim needs contention, not a particular number of
  // laps. So the budget is wall-clock and the laps are whatever fits — more
  // than twenty-five on a fast machine, fewer on a loaded CI runner, and never
  // a hang either way.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-clean-'));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    // A DURATION, NOT A DEADLINE THE PARENT PICKED. An absolute `until` is
    // fixed before the child is spawned, so on a loaded two-core runner a
    // worker can spend the whole budget starting up and complete zero laps —
    // failing the floor below for a reason that has nothing to do with the
    // lock. Timing from the child's own start also guarantees one full lap.
    'const [root, forMs] = [process.argv[2], Number(process.argv[3])];',
    'const until = Date.now() + forMs;',
    'let laps = 0;',
    'while (Date.now() < until) {',
    '  acquirePublicationLock(root)();',
    '  laps += 1;',
    '}',
    'process.stdout.write(String(laps));',
  ].join('\n'), 'utf8');

  try {
    // FOUR WORKERS, NOT EIGHT. Eight processes acquiring at maximum rate for
    // five seconds is a thundering herd rather than the "ordinary contention"
    // this test is named for, and on a two-core CI runner the backlog took
    // longer to drain than the kill window allowed — each worker must still
    // finish the acquire it is inside when its budget expires. Four processes
    // serialized through one gate is genuine contention and drains faster.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => run(worker, [dir, '3000'])),
    );
    for (const result of results) assert.equal(result.code, 0, result.stderr);

    // A wall-clock budget can be satisfied by doing nothing, which would make
    // the residue assertion below vacuous. What has to be true is that the lock
    // was genuinely contended — not that some number of laps happened.
    //
    // A total-lap floor is the wrong way to say that. It reads as a claim about
    // correctness and is really a claim about how fast the machine is: at 24 it
    // passed idle, then failed at 11 under load, because a contended
    // acquire-release costs hundreds of milliseconds of directory renames (see
    // D-075) and eight workers only get through so many in five seconds. The
    // invariant that does not depend on the hardware is that EVERY worker took
    // and released the lock at least once — eight processes serialized through
    // one gate, which is the contention this test is about.
    const laps = results.map((result) => Number(result.stdout) || 0);
    assert.ok(
      laps.every((count) => count >= 1),
      `every worker must complete an acquire/release; got ${JSON.stringify(laps)}`,
    );

    // THE CANONICAL PATH IS THE STRICT CLAIM. A directory left at
    // `.fiscus-build.lock` once every worker has exited is a HELD lock, and
    // whether it can still be recovered depends on whether the token it carries
    // names a living process. That is the defect this test exists for (D-077),
    // and it is asserted immediately, with no sweep allowed first.
    const canonical = readdirSync(dir).filter((name) => name === '.fiscus-build.lock');
    assert.deepEqual(canonical, [], 'the canonical lock survived every worker exiting, so it was abandoned held');

    // QUARANTINES ARE A WEAKER CLAIM, AND ASSERTING THE STRONGER ONE WAS WRONG.
    // `removeQuarantine` swallows a failed delete deliberately — on Windows a
    // recursive delete loses to an open handle exactly as a rename does — and
    // `reapOrphanQuarantines` exists because of it, running at the top of every
    // acquisition. So the design never promised "no quarantine ever survives";
    // it promised that an abandoned generation is collected by the next
    // acquisition. This test asserted the former and passed only because the
    // delete usually wins the race. Under real contention it does not: this run
    // left three, two from ordinary releases and one from a reclamation.
    //
    // So sweep, then assert. A quarantine that survives its own reaper is a
    // real leak; one that survives only until the next acquisition is the
    // documented behaviour.
    const reaper = join(dir, 'reaper.mjs');
    writeFileSync(reaper, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'acquirePublicationLock(process.argv[2])();',
    ].join('\n'), 'utf8');
    const swept = await run(reaper, [dir]);
    assert.equal(swept.code, 0, swept.stderr || 'the sweeping acquisition failed');

    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `lock residue survived a sweeping acquisition: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('the lost-race branch is not a blanket ENOENT catch', async () => {
  // The retry is reachable ONLY when this process created the directory. An
  // ENOENT from anywhere else — a root that does not exist, say — is a real
  // failure and must still throw rather than spin until the 300s wait timeout.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-arg-'));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'try {',
    '  acquirePublicationLock(process.argv[2]);',
    '  process.exit(0);',
    '} catch (error) {',
    '  process.stderr.write(String(error?.code ?? error));',
    '  process.exit(3);',
    '}',
  ].join('\n'), 'utf8');

  try {
    const result = await run(worker, [join(dir, 'no', 'such', 'root')]);
    assert.equal(result.code, 3, 'acquiring under a non-existent root must fail, not retry');
    assert.match(result.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('the publish branch decides by position, not by error code', () => {
  // The property that broke twice. `EEXIST` is a real distinction — someone
  // holds the lock, and that wait is unbounded — but once THIS process has
  // created the directory, no error in the owner-publish position means it
  // holds the lock. Branching on the code there is what made the repair
  // platform-specific, and what let macOS produce a fourth face of one
  // condition after Windows produced three.
  const source = readFileSync(join(ROOT, 'bin', 'publication-lock.mjs'), 'utf8');
  const branch = new RegExp('\\n      if \\(created\\) \\{([\\s\\S]*?)\\n      \\} else if').exec(source);
  assert.ok(branch, 'the created branch was not found — this test is pinned to its shape');

  assert.doesNotMatch(
    branch[1]!,
    /error\??\.code|code ===|code !==|includes\(code\)/,
    'the created branch must not inspect the error code: the list is platform-specific and the position is not',
  );
  // It must still be bounded, or a genuine permanent failure inside our own
  // directory spins until the 300s wait and reports the wrong problem.
  assert.match(branch[1]!, /PATH_CONTENTION_MS/, 'the retry must be bounded');
  assert.match(branch[1]!, /throw error/, 'a persistent failure must be reported as itself');

  // It must clean up after itself, and ONLY by token. Both halves are load
  // bearing and each was got wrong once: cleaning up by pathname took a fresh
  // lock away from another process, and cleaning up not at all left our own
  // orphan for us to wait on. `ownedByToken` is the only thing that separates
  // them, so a cleanup that stops consulting it has reintroduced one or the
  // other.
  assert.match(
    branch[1]!,
    /ownedByToken\(snapshot, token\)/,
    'the created branch must reclaim only what carries our own token',
  );
});

test('a release that cannot hand the lock back never returns still holding it', async () => {
  // THE MOST EXPENSIVE LINE IN THE FILE WAS A BARE `return`.
  //
  // Release claims its generation by renaming `owner.json` to
  // `.owner-quarantine.json`, then renames the whole directory aside. Each step
  // used to `return` on failure, and three of those returns left the canonical
  // directory in place still carrying a token-bearing record. `inspectLock`
  // reads that record as an owner; `lockIsStale` clears it as live, because the
  // PID it names is the releasing process and that process is still running.
  // Nothing can recover such a lock. Every contender waits out `LOCK_WAIT_MS`
  // and then reports `timed out waiting for another Fiscus build` about a build
  // that finished minutes earlier.
  //
  // Observed, not theorised: the repository root sat holding
  // `.owner-quarantine.json` for a live PID across a full minute of polling
  // while `test/build-race.test.ts` timed out behind it at 300s.
  //
  // HOW THE STATE IS MANUFACTURED. A DIRECTORY planted at
  // `.owner-quarantine.json` makes the first rename fail on every platform and
  // keep failing — `rename` cannot put a file where a directory is. That is a
  // stand-in for the real cause (a momentary open handle from an indexer or
  // another contender's scan), chosen because it is permanent and therefore
  // deterministic, where the real one cannot be held to a schedule.
  //
  // WHAT IT ASSERTS is not a shape but the invariant: whatever release could
  // not do, the lock must be acquirable afterwards. So the worker releases and
  // then acquires again in the same process, which is the strictest form of the
  // question — its own PID is alive, so nothing can rescue it by staleness.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-release-'));

  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const root = process.argv[2];',
    'const release = acquirePublicationLock(root);',
    '',
    "const lock = join(root, '.fiscus-build.lock');",
    '// Block the owner-record claim permanently, and make the obstruction',
    '// non-empty so no platform can quietly replace it.',
    "const blocker = join(lock, '.owner-quarantine.json');",
    'mkdirSync(blocker);',
    "writeFileSync(join(blocker, 'occupied'), 'x', 'utf8');",
    '',
    'release();',
    'const releasedAt = Date.now();',
    'acquirePublicationLock(root)();',
    'process.stdout.write(JSON.stringify({ reacquiredInMs: Date.now() - releasedAt }));',
  ].join('\n'), 'utf8');

  try {
    // Well under `LOCK_WAIT_MS`: a worker that has to be killed here is one that
    // went into the five-minute wait, which is the defect itself.
    const result = await run(worker, [dir], 120_000);

    assert.equal(result.code, 0, result.stderr || 'the release worker exited non-zero');
    const { reacquiredInMs } = JSON.parse(result.stdout) as { reacquiredInMs: number };
    // The abandon path removes the directory outright, or — if that removal is
    // swallowed — strips the owner record so the lock ages out on
    // `OWNERLESS_LOCK_STALE_MS`. Both clear well inside this bound; being held
    // by a live PID clears never.
    assert.ok(
      reacquiredInMs < 60_000,
      `the lock was still held after release: reacquiring took ${reacquiredInMs}ms`,
    );

    // And nothing was left behind at the root. A quarantine here would mean the
    // generation was moved aside but never collected.
    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `release left lock residue: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('an owner-less lock cannot outlast the wait that queues behind it', () => {
  // A directory carrying no token in any form is recovered on a timer rather
  // than by PID, and that timer has to clear inside the window contenders are
  // willing to wait. At `LOCK_STALE_MS` it did not: ten minutes of staleness
  // against five minutes of waiting means every contender times out first and
  // the directory is still there for the next one. Whatever the two values
  // become, this relation is the one that has to hold.
  // Read from the source rather than imported: `bin/` ships no declarations, so
  // a typed import of a `.mjs` module is an implicit `any` under this config.
  const source = readFileSync(join(ROOT, 'bin', 'publication-lock.mjs'), 'utf8');
  const declared = (name: string): number => {
    const match = new RegExp(`export const ${name} = ([0-9_*\\s]+);`).exec(source);
    assert.ok(match, `${name} is no longer declared where this test reads it`);
    // The declarations are numeric literals with separators, and one is a
    // product (`10 * 60_000`). Evaluating the literal keeps the test reading the
    // real value rather than a copy of it that can drift.
    return Number(new Function(`return ${match[1]!.replace(/_/g, '')};`)());
  };

  const ownerless = declared('OWNERLESS_LOCK_STALE_MS');
  const wait = declared('LOCK_WAIT_MS');
  assert.ok(Number.isFinite(ownerless) && ownerless > 0, 'the owner-less grace must be a positive duration');
  assert.ok(
    ownerless < wait,
    `an owner-less lock is recovered after ${ownerless}ms but contenders give up after `
    + `${wait}ms, so one such directory parks every one of them`,
  );
});

test('a lock this process left under an earlier token is reclaimed, not waited for', async () => {
  // CI run `33630894290` killed one of four contenders at the 180s harness
  // window on ubuntu, macOS and candidate-head. `LOCK_WAIT_MS` is 300s, so the
  // worker was still waiting; every other worker had exited seconds earlier, so
  // the only process left alive to own anything was the worker itself.
  //
  // THE GUARD WAS ONE CALL WIDE. The acquire loop already knows that waiting on
  // its own orphan never ends — `lockIsStale` asks whether the owner's PID is
  // alive, and for this process the answer is permanently yes — and it guards
  // that with `ownedByToken`. But the token is minted per `acquirePublicationLock`
  // CALL, so a generation left behind by an earlier call of the same process
  // carries a token this call has never heard of. Different token, same live
  // PID: not ours to reclaim, not stale, wait five minutes for ourselves.
  //
  // The state is planted directly rather than raced for. What matters is not
  // how the orphan came to exist — the release path is bounded and terminal, so
  // the routes are narrow — but that a process which meets one can make
  // progress. A record naming OUR pid was written either by us or by a dead
  // process whose pid we inherited, and reclaiming is right in both readings.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-self-'));
  const script = join(dir, 'self-orphan.mjs');
  writeFileSync(script, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const root = process.argv[2];',
    "const lock = join(root, '.fiscus-build.lock');",
    'mkdirSync(lock);',
    // A well-formed owner record naming this very process under a token this
    // process is not holding: exactly what an earlier call would have left.
    "writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'an-earlier-generation' }), 'utf8');",
    'const started = Date.now();',
    'acquirePublicationLock(root)();',
    'process.stdout.write(String(Date.now() - started));',
  ].join('\n'), 'utf8');

  try {
    // Well below `LOCK_WAIT_MS`, so a wait that ends only at its own bound is a
    // kill rather than a slow pass. Well above the reclamation's own budget.
    const result = await run(script, [dir], 60_000);
    assert.equal(result.code, 0, result.stderr || 'the process never stopped waiting for itself');
    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `reclaiming left lock residue: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('re-entering a lock this process genuinely holds fails fast rather than waiting for itself', async () => {
  // The other half of the same rule, and the reason it cannot simply be "a
  // record naming our PID is ours to remove". A process that acquires twice
  // without releasing is not looking at an orphan — it holds that lock, and
  // reclaiming it would hand the same lock to two holders at once.
  //
  // Waiting is not the answer either: it is a deadlock with a five-minute
  // fuse that then reports `timed out waiting for another Fiscus build` about
  // itself. Nothing in this repository acquires re-entrantly; if something
  // starts to, it should find out at the call rather than in CI.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-reentrant-'));
  const script = join(dir, 'reentrant.mjs');
  writeFileSync(script, [
    `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
    'const release = acquirePublicationLock(process.argv[2]);',
    'try {',
    '  acquirePublicationLock(process.argv[2])();',
    "  process.stdout.write('acquired-twice');",
    '} catch (error) {',
    '  process.stdout.write(`threw:${error.message}`);',
    '} finally {',
    '  release();',
    '}',
  ].join('\n'), 'utf8');

  try {
    const result = await run(script, [dir], 60_000);
    assert.equal(result.code, 0, result.stderr || 'the re-entrant acquisition never returned');
    assert.match(result.stdout, /^threw:/, 'a second acquisition must not succeed while the first is held');
    assert.match(result.stdout, /already held by this process/);
    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `the held lock was not released: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('a restore that loses the canonical path is a lost race, not a fatal errno', async () => {
  // THE ERRNO LIST OUTLIVED THE LESSON THIS FILE OPENS WITH.
  //
  // The header above records D-072 removing an enumeration of platform error
  // codes because "the list is a property of the kernel it happens to run on".
  // `restoreQuarantinedLock` kept one — ENOENT, EACCES, EBUSY, EPERM, EEXIST —
  // and rethrew anything else. Renaming a directory onto an existing NON-EMPTY
  // directory answers EEXIST on Windows and ENOTEMPTY on Linux, and POSIX
  // permits either, so the list was complete on the platform it was written on
  // and wrong on the one CI runs. Exact-head run `33730517441` killed a worker
  // with a raw ENOTEMPTY out of `acquirePublicationLock`:
  //
  //     Error: ENOTEMPTY: directory not empty, rename
  //       '.../.fiscus-build.lock.quarantine-7086-63ed67ff' -> '.../.fiscus-build.lock'
  //         at restoreQuarantinedLock (bin/publication-lock.mjs:333)
  //         at quarantineUnknownLock (bin/publication-lock.mjs:353)
  //         at acquirePublicationLock (bin/publication-lock.mjs:674)
  //
  // WHY NO FAILURE THERE MAY BE FATAL, WHICH IS THE POSITION RATHER THAN THE
  // ENTRY. Once the lock has been renamed aside the canonical path is ABSENT and
  // any contender may claim it at once, so restoration is best-effort by
  // construction. A failure means somebody else got there first — the ordinary
  // outcome of a race this protocol is designed to lose. Both callers already
  // discard the answer and return false regardless.
  //
  // MANUFACTURING THE PRECONDITION. Both call sites are reachable only through a
  // genuine interleaving — an owner record appearing between the inspection that
  // said "unknown" and the re-read after the rename — so this cannot be driven
  // by planting a single state. What it CAN do is make the window common: a
  // thief re-creates the canonical path as a NON-EMPTY directory (a valid owner
  // record naming a process that has already exited) every time it observes the
  // path go absent, which is exactly the moment a quarantine is outstanding. The
  // dead owner keeps it immediately reclaimable, so workers still make progress
  // instead of serving the ten-second ownerless age.
  //
  // WHAT THIS DOES NOT ESTABLISH. It cannot go RED on Windows, where the
  // occupied-target rename answers EPERM or EEXIST — both of which the old list
  // already tolerated. The defect and its repair are visible only where the
  // kernel answers with a code nobody enumerated, which is why the authoritative
  // gate for this one is Ubuntu CI rather than a local run.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-restore-'));
  try {
    // A pid that is certainly gone: this process ran, reported itself, exited.
    const corpse = join(dir, 'corpse.mjs');
    writeFileSync(corpse, 'process.stdout.write(String(process.pid));\n', 'utf8');
    const dead = await run(corpse, []);
    assert.equal(dead.code, 0, dead.stderr || 'the corpse process failed to report a pid');
    const deadPid = Number(dead.stdout);
    assert.ok(Number.isInteger(deadPid) && deadPid > 0, `expected a pid, read ${JSON.stringify(dead.stdout)}`);

    const thief = join(dir, 'thief.mjs');
    writeFileSync(thief, [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const [root, forMs, deadPid] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];',
      'const until = Date.now() + forMs;',
      'let steals = 0;',
      'while (Date.now() < until) {',
      "  const lock = join(root, '.fiscus-build.lock');",
      '  try {',
      // mkdir is the claim. Only the process that wins it writes the record, so
      // the thief never overwrites a real builder's owner file.
      '    mkdirSync(lock);',
      "    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid, token: 'thief-' + steals }), 'utf8');",
      '    steals += 1;',
      '  } catch { /* the path is claimed by a real contender; that is the normal case */ }',
      '}',
      'process.stdout.write(String(steals));',
    ].join('\n'), 'utf8');

    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'const [root, forMs] = [process.argv[2], Number(process.argv[3])];',
      'const until = Date.now() + forMs;',
      'let laps = 0;',
      'while (Date.now() < until) {',
      '  acquirePublicationLock(root)();',
      '  laps += 1;',
      '}',
      'process.stdout.write(String(laps));',
    ].join('\n'), 'utf8');

    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => run(worker, [dir, '2500'])),
      run(thief, [dir, '2500', String(deadPid)]),
    ]);
    const workers = results.slice(0, 3);

    // THE ASSERTION THE DEFECT VIOLATED. A lost race must not reach the caller
    // as a filesystem error. Checked as a class rather than as this run's code,
    // because naming the code would rebuild the list this test exists to delete.
    for (const result of workers) {
      assert.doesNotMatch(
        result.stderr,
        /\b(?:ENOTEMPTY|ENOTDIR|EEXIST|EPERM|EACCES|EBUSY|EINVAL|ENOENT)\b/,
        `a raw filesystem errno escaped acquisition: ${result.stderr}`,
      );
      assert.equal(result.code, 0, result.stderr || 'a worker died contending with a lock thief');
    }

    // Non-vacuity. A worker that never acquired would satisfy every assertion
    // above while proving nothing about the restore path.
    const laps = workers.map((result) => Number(result.stdout) || 0);
    assert.ok(
      laps.reduce((total, count) => total + count, 0) >= 1,
      `no worker completed an acquire/release, so the contention never happened; got ${JSON.stringify(laps)}`,
    );

    // And the generations the thief abandoned are collected by owner liveness,
    // exactly as an ordinary quarantine is — its pid was dead from the start.
    const reaper = join(dir, 'reaper.mjs');
    writeFileSync(reaper, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'acquirePublicationLock(process.argv[2])();',
    ].join('\n'), 'utf8');
    const swept = await run(reaper, [dir]);
    assert.equal(swept.code, 0, swept.stderr || 'the sweeping acquisition failed');

    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `lock residue survived a sweeping acquisition: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

/**
 * THE GRACE PERIOD BELONGS TO THE CANONICAL PATH, NOT TO A QUARANTINE.
 *
 * `reapOrphanQuarantines` asks `lockIsStale`, which answers a DIFFERENT
 * question: may I take this canonical lock? Half of that answer transfers — an
 * owner who cannot still act is gone, wherever the directory sits — and half
 * does not. For an owner-LESS directory `lockIsStale` waits
 * `OWNERLESS_LOCK_STALE_MS`, and the reason is stated in its own comment: the
 * creator died "between `mkdir` and its first write", so the ten seconds
 * protect a live process that is about to write its record into a directory it
 * has just made.
 *
 * No such process can exist at a quarantine pathname. A quarantine is only ever
 * created by RENAMING an existing directory aside; nothing is ever `mkdir`ed
 * there, and no creator will ever come back to a name it does not know. So the
 * ten seconds protect nobody and delay collection of a directory that is
 * already garbage.
 *
 * HOW THE WINDOW IS REACHED IN PRACTICE, which is what run `33760552077` found
 * on Ubuntu and Windows both. `quarantineKnownLock` renames whatever is at the
 * canonical path at the instant it acts, which need not be the generation it
 * inspected: a contender can quarantine and remove that generation and a third
 * process can `mkdir` a fresh empty one in between. The mismatch is then
 * detected — that is what the re-read of the owner record is for — restoration
 * is attempted, and when the canonical path has been claimed again it fails,
 * which is the ordinary lost race D-092 recorded. What is left behind is an
 * EMPTY quarantine: a directory whose creator can no longer find it and whose
 * record was never written. The reaper then preserved it for ten seconds, and
 * an immediate sweeping acquisition reported residue.
 *
 * These three tests state the transition rule directly rather than reproducing
 * the interleaving, which is the whole of the directive's preference for a
 * state-machine test: a planted state is deterministic on every platform, where
 * the race that produces it is not.
 */
test('an ownerless quarantine is collected at once, not after the canonical grace period', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-reap-ownerless-'));
  try {
    // Exactly what the mismatch path leaves: a directory with no record at all,
    // at a pathname no creator knows.
    const orphan = join(dir, '.fiscus-build.lock.quarantine-1-00000000-0000-4000-8000-000000000001');
    mkdirSync(orphan);

    const sweeper = join(dir, 'sweeper.mjs');
    writeFileSync(sweeper, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'acquirePublicationLock(process.argv[2])();',
    ].join('\n'), 'utf8');
    const swept = await run(sweeper, [dir], 60_000);
    assert.equal(swept.code, 0, swept.stderr || 'the sweeping acquisition failed');

    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `an ownerless quarantine survived its reaper: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('a quarantine whose owner can still act is preserved, not deleted by pathname', async () => {
  // THE GUARD-RAIL. Collecting every quarantine on sight would satisfy the test
  // above and reintroduce the pathname-based deletion D-072 removed. The owner
  // half of the rule is unchanged: a live owner keeps its generation.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-reap-live-'));
  try {
    const held = join(dir, '.fiscus-build.lock.quarantine-1-00000000-0000-4000-8000-000000000002');
    mkdirSync(held);
    // This process is alive for as long as the child sweeps.
    writeFileSync(
      join(held, '.owner-quarantine.json'),
      JSON.stringify({ pid: process.pid, token: 'live-owner' }),
      'utf8',
    );

    const sweeper = join(dir, 'sweeper.mjs');
    writeFileSync(sweeper, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'acquirePublicationLock(process.argv[2])();',
    ].join('\n'), 'utf8');
    const swept = await run(sweeper, [dir], 60_000);
    assert.equal(swept.code, 0, swept.stderr || 'the sweeping acquisition failed');

    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [held.slice(dir.length + 1)], 'a live owner lost its quarantined generation');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test('a quarantine whose owner is demonstrably gone is still collected by liveness', async () => {
  // The half of `lockIsStale` that does transfer, kept visible so a later change
  // cannot quietly narrow the reaper to the ownerless case.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lock-reap-dead-'));
  try {
    const corpse = join(dir, 'corpse.mjs');
    writeFileSync(corpse, 'process.stdout.write(String(process.pid));\n', 'utf8');
    const dead = await run(corpse, [], 60_000);
    assert.equal(dead.code, 0, dead.stderr || 'the corpse process failed to report a pid');
    const deadPid = Number(dead.stdout);
    assert.ok(Number.isInteger(deadPid) && deadPid > 0, `expected a pid, read ${JSON.stringify(dead.stdout)}`);

    const abandoned = join(dir, '.fiscus-build.lock.quarantine-1-00000000-0000-4000-8000-000000000003');
    mkdirSync(abandoned);
    writeFileSync(
      join(abandoned, '.owner-quarantine.json'),
      JSON.stringify({ pid: deadPid, token: 'dead-owner' }),
      'utf8',
    );

    const sweeper = join(dir, 'sweeper.mjs');
    writeFileSync(sweeper, [
      `import { acquirePublicationLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'acquirePublicationLock(process.argv[2])();',
    ].join('\n'), 'utf8');
    const swept = await run(sweeper, [dir], 60_000);
    assert.equal(swept.code, 0, swept.stderr || 'the sweeping acquisition failed');

    const residue = readdirSync(dir).filter((name) => name.startsWith('.fiscus-build.lock'));
    assert.deepEqual(residue, [], `a dead owner's quarantine survived: ${residue.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

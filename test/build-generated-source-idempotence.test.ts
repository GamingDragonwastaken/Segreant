/**
 * Two concurrent builds rewrote the source files a third one was compiling.
 *
 * THE FAILURE, FINALLY CAPTURED. `test/build-race.test.ts`'s "concurrent builds
 * keep the compiled CLI runnable throughout publication" has failed
 * intermittently since it was written, and was recorded as an open finding with
 * no diagnosis because the output scrolled away every time. It reproduced on CI
 * at `cc8ef35`, on `test (windows-latest)` only, with the message kept:
 *
 *     AssertionError: build failed: browser app
 *     2 !== 0    at test/build-race.test.ts:94
 *
 * One of the two concurrent builders exited 2 while compiling the browser app.
 *
 * WHY. `scripts/build.mjs` compiles each pass into a private staging directory,
 * so the two builders never write the same OUTPUT. They do share their INPUT,
 * and one of those inputs is generated: `syncSharedDashboardContract()` copies
 * `src/dashboard/contracts.ts` over
 * `src/dashboard/web/app/core/generated-contract.ts` and runs
 * `scripts/generate-dashboard-payload-contract.mjs`, which writes two more files
 * into `src/`. That runs under the publication lock, which serializes the two
 * WRITES against each other — and not against the other builder's `tsc`, which
 * reads the same files with no lock at all, because compiling holds no lock by
 * design.
 *
 * So builder B rewrites a source file while builder A's browser-app `tsc` has
 * it open. On Windows that is a truncated read or a sharing violation; on POSIX
 * the same window exists and is far more forgiving, which is exactly why this
 * failed on one runner out of three.
 *
 * THE FIX IS THAT THE WRITE IS UNNECESSARY. Both builders generate byte-identical
 * content from the same sources — that is what "generated" means. Writing bytes
 * that are already there is a no-op semantically and is not a no-op on the
 * filesystem. So the generated files are written only when their content would
 * actually change, and the race closes for every case where the source has not
 * moved, which is every concurrent build of one tree.
 *
 * WHAT THIS DOES NOT FIX, STATED PLAINLY. A build running while somebody EDITS
 * `src/dashboard/shared-types.ts` still rewrites the generated files, and a
 * concurrent compile can still read one mid-write. That window is real and is
 * not closed here; `sourceFingerprint` already refuses to PUBLISH a mixed source
 * generation, so the outcome there is a refusal rather than a bad artifact, and
 * the build failure the fingerprint check does not prevent remains possible. The
 * claim is narrower than "the race is gone": **a build no longer perturbs the
 * source tree when nothing has changed**, which is the case that was failing.
 *
 * Recorded at D-172.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATOR = join(ROOT, 'scripts', 'generate-dashboard-payload-contract.mjs');

/**
 * The files the GENERATOR writes into the source tree.
 *
 * `generated-contract.ts` is not among them: that one is a plain
 * `copyFileSync` in `scripts/build.mjs` rather than generator output, and it is
 * covered by the third test below. Both writers had the same defect and a fix
 * to either alone would still race, which is why they are checked separately
 * instead of being folded into one list.
 */
const GENERATED = [
  join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'generated-payload-contract.ts'),
  join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'generated-types.ts'),
];

function runGenerator(): void {
  execFileSync(process.execPath, [GENERATOR], { cwd: ROOT, stdio: 'pipe' });
}

test('the generator writes into the source tree only when the content would change', () => {
  // THE COUNTEREXAMPLE. Every build ran this unconditionally, so a second
  // builder rewrote files the first builder's `tsc` was reading. The content is
  // identical by construction -- both derive it from the same source -- so the
  // write had nothing to do except open the file.
  runGenerator();

  const before = GENERATED.map((path) => {
    // Backdate so an unchanged file is distinguishable from one rewritten with
    // the same bytes; mtime resolution is otherwise coarse enough to hide it.
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    return { path, mtimeMs: statSync(path).mtimeMs, content: readFileSync(path, 'utf8') };
  });

  runGenerator();

  for (const entry of before) {
    assert.equal(
      readFileSync(entry.path, 'utf8'),
      entry.content,
      `${entry.path} must be byte-identical across two runs, or it is not generated from its source alone`,
    );
    assert.equal(
      statSync(entry.path).mtimeMs,
      entry.mtimeMs,
      `${entry.path} was rewritten with the bytes it already had, which is what a concurrent compile reads mid-write`,
    );
  }
});

test('the generator does write when the content genuinely differs', () => {
  // The other direction, and the reason this cannot be fixed by never writing.
  // Without it, a stale generated file would satisfy the test above forever.
  const target = GENERATED[1]!;
  const original = readFileSync(target, 'utf8');
  try {
    writeFileSync(target, `${original}\n// perturbed by a test\n`, 'utf8');
    runGenerator();
    assert.equal(readFileSync(target, 'utf8'), original, 'a generated file that drifted must be rewritten');
  } finally {
    // Restore whatever the generator should produce, so a failure here cannot
    // leave the tree dirty for every later test in the run.
    runGenerator();
    assert.equal(readFileSync(target, 'utf8'), original);
  }
});

test('a real build does not perturb the source tree when nothing has changed', () => {
  // THE PROPERTY THE RACE ACTUALLY NEEDS, tested through the real build rather
  // than through a re-implementation of its logic. `syncSharedDashboardContract`
  // copies one file with `copyFileSync` and the generator writes the other two;
  // a fix applied to only one of those writers would pass the tests above and
  // still perturb a compiling neighbour. `--web` is used because it runs the
  // same top-level sync and skips the node-runtime pass, which is the expensive
  // half and has nothing to do with this claim.
  const watched = [
    join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'generated-contract.ts'),
    ...GENERATED,
  ];

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--web'], { cwd: ROOT, stdio: 'pipe' });

  const old = new Date(Date.now() - 60_000);
  const before = watched.map((path) => {
    utimesSync(path, old, old);
    return { path, mtimeMs: statSync(path).mtimeMs };
  });

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--web'], { cwd: ROOT, stdio: 'pipe' });

  for (const entry of before) {
    assert.equal(
      statSync(entry.path).mtimeMs,
      entry.mtimeMs,
      `${entry.path} was rewritten by a build that changed nothing -- a concurrent tsc reading it is what fails`,
    );
  }
});

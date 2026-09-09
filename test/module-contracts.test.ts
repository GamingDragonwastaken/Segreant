/**
 * A MODULE CONTRACT IS A PROJECTION OF ITS MODULE, AND NOTHING READ IT.
 *
 * Fifteen `CONTEXT.md` files under `src/` are the interface a newcomer meets
 * first — human or agent — and until this test existed, nothing compared a
 * single sentence of them against the code they describe. They drifted exactly
 * as D-188 predicted a projection drifts: `src/epistemic/CONTEXT.md` said
 * "Three boundaries … strengthen claims outside the kernel" when there was one,
 * `src/measurement/CONTEXT.md` said no production site resolves a measurement
 * model when one does, and `src/store/CONTEXT.md` said "all amounts are integer
 * microdollars" about a store whose amounts are arbitrary-scale decimals.
 *
 * D-188's lesson was that `ISSUANCE-MAP.md` claimed to be the readable
 * projection of the map and drifted in every column the test did not compare.
 * The same argument applies here with the same force, so this checks the claim
 * forms that CAN be checked mechanically.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not parse prose, and the honest
 * record is that **the mechanical checks below found none of the three false
 * claims above.** All three are ordinary English sentences with no
 * machine-checkable shape; they were found by reading, verified against the
 * code, and corrected by hand at D-198, and they can rot again tomorrow.
 * Pretending prose is parseable would produce a check that fires on rewording
 * and gets weakened by the next engineer who trips over it.
 *
 * The first draft of the file check DID go red — on five references in
 * `src/dashboard/CONTEXT.md`, every one of which was true. The checker was
 * wrong: it resolved a bare name against the contract's directory and anything
 * with a slash against the repository root, and `web/app/core/generated-types.ts`
 * is written relative to the module. Correcting the contracts to match it would
 * have damaged four true sentences. That near-miss is why references are now
 * matched by suffix against `git ls-files`, and why this file argues that **a
 * false positive is worse than a miss** in a gate over documentation.
 *
 * One direction is not checked at all: a module that gains an export its
 * contract never mentions. Nothing here notices silence.
 *
 * SO THE GATE STATES ITS OWN COVERAGE, and that is not decoration. A check that
 * silently examines three sentences out of two hundred and reports success is
 * the defect class this repository has recorded twenty-one times and written up
 * in `docs/program/METHOD-ABSENCE-AS-RESULT.md`: an absence reported as a
 * result. The last test in this file asserts the number of checked claims
 * cannot silently fall, and prints what it did not check.
 *
 * Recorded at D-198.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, importersOf, sourceFiles } from './support/importGraph.ts';

/** Every module contract, found on disk so a new module's contract is covered the day it lands. */
function contracts(): string[] {
  return sourceFiles()
    .map((file) => file.replace(/\/[^/]+$/, '/CONTEXT.md'))
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => existsSync(join(ROOT, file)));
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/**
 * A backticked path is checkable; a backticked word is not necessarily. Only
 * `.ts`, `.mjs` and `.md` are matched: `dist/cli.js` names a build output that
 * exists only after a build, and a check that depends on whether someone ran
 * the build is a flake, not a gate.
 */
const FILE_REFERENCE = /`([A-Za-z0-9_./-]+\.(?:ts|mjs|md))`/g;
const CALL_REFERENCE = /`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g;
const NOTHING_CALLS = /nothing\s+(?:calls|imports)\s+`([A-Za-z0-9_./-]+\.ts)`/gi;
const ANY_CODE_SPAN = /`[^`\n]+`/g;

/**
 * Every tracked file, so a reference can be matched by SUFFIX rather than by
 * guessing which directory it was written relative to.
 *
 * The first version of this test resolved a bare name against the contract's
 * own directory and anything containing a slash against the repository root.
 * It reported five failures in `src/dashboard/CONTEXT.md` and every one was
 * wrong: `web/app/core/generated-types.ts` is written relative to the module,
 * and `dom.ts` lives in a subdirectory of it. Had those been "corrected", four
 * true sentences would have been edited to match a broken checker. **A false
 * positive here is worse than a miss**, because the engineer who hits one
 * weakens the gate rather than the contract.
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Does any tracked path end with this reference? */
function referenceResolves(files: string[], reference: string): boolean {
  return files.some((file) => file === reference || file.endsWith(`/${reference}`));
}

/** A bare filename is relative to the contract's own directory; anything with a slash is from the root. */
function resolveReference(contract: string, reference: string): string {
  if (reference.includes('/')) return reference;
  return contract.replace(/CONTEXT\.md$/, reference);
}

let checkedClaims = 0;

test('every file a module contract names actually exists', () => {
  const files = trackedFiles();
  const missing: string[] = [];
  for (const contract of contracts()) {
    for (const match of read(contract).matchAll(FILE_REFERENCE)) {
      const reference = match[1]!;
      checkedClaims += 1;
      if (!referenceResolves(files, reference)) {
        missing.push(`${contract}: names \`${reference}\`, which is not a tracked file anywhere in the repository`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a module contract names a file that is not there');
});

test('every symbol a module contract calls out still exists in the source', () => {
  const source = sourceFiles().map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');
  const absent: string[] = [];
  for (const contract of contracts()) {
    for (const match of read(contract).matchAll(CALL_REFERENCE)) {
      const symbol = match[1]!;
      checkedClaims += 1;
      // Deliberately weak: the identifier must appear SOMEWHERE under `src/`.
      // A stricter rule (exported by this module) would fire on the many
      // contracts that legitimately name a neighbour's function, and a gate
      // that cries wolf is a gate someone deletes.
      if (!new RegExp(`\\b${symbol}\\b`).test(source)) {
        absent.push(`${contract}: names \`${symbol}()\`, which appears nowhere under src/`);
      }
    }
  }
  assert.deepEqual(absent, [], 'a module contract names a symbol the source no longer has');
});

test('a contract that says nothing calls a file is checked against the real import graph', () => {
  const wrong: string[] = [];
  let claims = 0;
  for (const contract of contracts()) {
    for (const match of read(contract).matchAll(NOTHING_CALLS)) {
      const resolved = resolveReference(contract, match[1]!);
      claims += 1;
      checkedClaims += 1;
      const importers = importersOf(resolved);
      if (importers.length > 0) {
        wrong.push(`${contract}: claims nothing calls \`${match[1]}\`, but ${importers.join(', ')} import it`);
      }
    }
  }
  assert.deepEqual(wrong, [], 'a contract claims a module is unreached and the import graph disagrees');
  // The corpus rule from D-166: a sweep that finds nothing is worth its
  // enumeration, so the enumeration is asserted rather than described.
  assert.ok(claims >= 1, 'the reach-claim pattern matched nothing at all, which means it stopped working');
});

/**
 * THE COVERAGE STATEMENT, which is the part of this file most likely to be
 * quietly deleted by someone adding a claim form.
 *
 * `checkedClaims` counts what the three tests above actually compared. The
 * floor stops that number falling without anyone noticing — a regex that stops
 * matching is the failure mode here, and it is silent by nature.
 */
test('the gate states how much of the contract prose it actually checks', () => {
  const spans = contracts().reduce((total, contract) => total + [...read(contract).matchAll(ANY_CODE_SPAN)].length, 0);
  assert.ok(checkedClaims >= 70, `checked claims fell to ${checkedClaims}; a claim form has stopped matching`);
  console.log(
    `module contracts: ${contracts().length} files, ${checkedClaims} claims checked, `
    + `${spans - checkedClaims} code spans and all prose sentences UNCHECKED and free to rot`,
  );
});

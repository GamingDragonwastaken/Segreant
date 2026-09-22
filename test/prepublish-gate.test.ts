/**
 * The publish gate is only worth what it actually checks (WP-H05).
 *
 * This repository has THREE compilation domains — the root `tsconfig.json`,
 * the browser app at `src/dashboard/web/app/tsconfig.json`, and `team-server/`,
 * a separate npm project with its own `tsconfig.json` and `node_modules` that
 * imports root source directly (`../../src/team/rollup.ts`,
 * `../../src/value/receipt.ts`). A rename anywhere in `src/team/` or
 * `src/value/` can break `team-server/` while every root gate stays green —
 * this has already reached CI twice (TS1294 at `31911cb`, sixteen
 * TS2339/TS2353 errors at `c1f7ac5`), both times because the local check
 * stopped at the root.
 *
 * `npm run prepublishOnly` is the last gate before `npm publish`. Before this
 * test existed it ran `npm run typecheck && npm test && npm run build` —
 * `npm run typecheck` is `tsc --noEmit` with no `-p`, which resolves the root
 * `tsconfig.json` alone (that config's own `exclude` carves the web app out,
 * and it never mentions `team-server/` at all). A publish gate checking one
 * domain of three can publish a package whose repository does not compile.
 *
 * Proved by hand before this test was written: renaming the exported
 * `RollupBody` interface in `src/team/rollup.ts` (and its two internal uses in
 * that file) left `node ./node_modules/typescript/bin/tsc --noEmit -p
 * tsconfig.json` and the web app's own typecheck both green, and left
 * `test/team-rollup.test.ts` passing, while `team-server`'s own typecheck
 * failed with exactly the TS2305 shape CLAUDE.md records: `team-server/src/store.ts`
 * imports `RollupBody` as a type and has no other definition of it. That break
 * was reverted before committing; nothing here depends on it staying broken.
 *
 * This test does not execute `team-server`'s toolchain — the root `npm test`
 * run has no guarantee that `team-server/node_modules` exists (root `npm ci`
 * does not install it; `team-server` is not an npm workspace), so a functional
 * run here would make the root suite depend on an install this file has no way
 * to cause. Instead it reads `package.json` as data and pins the *composition*
 * of `prepublishOnly`: that it is built from a step per domain, that each of
 * those steps names the file that makes it that domain's check, and that the
 * checker used below actually tells a covered gate from an uncovered one
 * (the "not vacuous" tests), so a future edit that quietly drops a domain — the
 * exact failure mode CLAUDE.md describes as having already happened twice —
 * fails this file instead of reaching CI a third time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

interface PackageJson {
  scripts?: Record<string, string>;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(read('package.json')) as PackageJson;
}

/**
 * Expand every `npm run <name>` (and `npm run-script <name>`) token in a
 * script command, recursively, into the command it resolves to — so a domain
 * hidden behind a level of indirection (`prepublishOnly` calling
 * `typecheck:all` calling `typecheck:web`) is still visible to a substring
 * check on the result. Unresolvable or cyclic references are left as-is
 * rather than thrown away, so a broken reference shows up as a literal
 * `npm run <name>` in the flattened text instead of silently vanishing.
 */
function flatten(scripts: Record<string, string>, name: string, seen: Set<string> = new Set()): string {
  const command = scripts[name];
  if (command === undefined) return `npm run ${name}`;
  if (seen.has(name)) return command; // cycle guard: stop expanding, keep the text
  const nextSeen = new Set(seen).add(name);
  return command.replace(/npm run(?:-script)? +([\w:-]+)/g, (whole, ref: string) => {
    if (!(ref in scripts)) return whole;
    return `(${flatten(scripts, ref, nextSeen)})`;
  });
}

/**
 * What the flattened `prepublishOnly` text says about coverage of each of the
 * three compilation domains. A plain object of booleans rather than one big
 * assertion so each domain fails with its own message, and so the
 * "not vacuous" tests below can show the same function telling a covered gate
 * from an uncovered one.
 */
function domainCoverage(flattened: string): { root: boolean; web: boolean; teamServer: boolean } {
  return {
    // The root domain's own signature: `tsc --noEmit` with no `-p`, so it
    // resolves tsconfig.json in the invocation's own directory.
    root: /tsc(?:\.[a-z]+)?\s+--noEmit(?!\s+-p)/.test(flattened) || /--noEmit\b(?![\s\S]*-p )/.test(flattened),
    web: flattened.includes('src/dashboard/web/app/tsconfig.json'),
    // The team-server domain's signature: something that changes into (or is
    // prefixed at) team-server AND runs a compiler check there. Requiring
    // both halves means a step that merely mentions the word `team-server` in
    // a comment or label, without actually reaching its toolchain, does not
    // count.
    teamServer:
      /(--prefix[= ]team-server|cd\s+team-server\b)/.test(flattened)
      && /(tsc(?:\.[a-z]+)?\s+--noEmit|run typecheck\)|run typecheck:team-server\)|run typecheck\b)/.test(flattened),
  };
}

test('prepublishOnly is defined and package.json parses as an object of scripts', () => {
  const { scripts } = loadPackageJson();
  assert.ok(scripts, 'package.json must declare a scripts object');
  assert.equal(typeof scripts.prepublishOnly, 'string', 'package.json must declare a prepublishOnly script');
});

test('prepublishOnly checks all three compilation domains: root, browser app, and team-server', () => {
  const { scripts } = loadPackageJson();
  const flattened = flatten(scripts!, 'prepublishOnly');
  const coverage = domainCoverage(flattened);

  assert.ok(
    coverage.root,
    `prepublishOnly (flattened: ${flattened}) does not appear to typecheck the root domain `
    + `(a bare "tsc --noEmit" resolving tsconfig.json)`,
  );
  assert.ok(
    coverage.web,
    `prepublishOnly (flattened: ${flattened}) does not typecheck the browser app at `
    + `src/dashboard/web/app/tsconfig.json — this is the domain CLAUDE.md calls out as excluded `
    + `from the root tsconfig.json`,
  );
  assert.ok(
    coverage.teamServer,
    `prepublishOnly (flattened: ${flattened}) does not typecheck team-server/, which imports root `
    + `source directly (../../src/team/rollup.ts, ../../src/value/receipt.ts) — this exact gap has `
    + `reached CI twice (TS1294 at 31911cb, TS2339/TS2353 at c1f7ac5)`,
  );
});

test('prepublishOnly also runs team-server\'s own test suite, not only its typecheck', () => {
  // Typechecking catches a broken import; it does not catch a signature that
  // still type-checks but now means something else. CLAUDE.md's own
  // documented validation sequence for touching src/team/ or src/value/ ends
  // in `npm test` inside team-server, not just its typecheck.
  const { scripts } = loadPackageJson();
  const flattened = flatten(scripts!, 'prepublishOnly');
  assert.ok(
    /(--prefix[= ]team-server|cd\s+team-server\b)/.test(flattened) && /\btest\b/.test(flattened),
    `prepublishOnly (flattened: ${flattened}) does not run team-server's own test suite`,
  );
});

test('the domains named in prepublishOnly are files that actually exist and are actually distinct', () => {
  assert.ok(existsSync(join(ROOT, 'tsconfig.json')), 'root tsconfig.json must exist');
  assert.ok(
    existsSync(join(ROOT, 'src', 'dashboard', 'web', 'app', 'tsconfig.json')),
    'browser app tsconfig.json must exist',
  );
  assert.ok(existsSync(join(ROOT, 'team-server', 'tsconfig.json')), 'team-server tsconfig.json must exist');
  assert.ok(existsSync(join(ROOT, 'team-server', 'package.json')), 'team-server package.json must exist');

  // The root config must still be the one excluding the web app — otherwise
  // "root" and "web" would be the same domain wearing two names, and this
  // test's three-domain claim would be checking the same thing twice.
  const rootConfig = read('tsconfig.json');
  assert.ok(
    rootConfig.includes('src/dashboard/web/app/**'),
    'root tsconfig.json must still exclude the web app for the three domains to be genuinely distinct',
  );
});

test('domainCoverage is not vacuous: it tells the pre-fix gate apart from the fixed one', () => {
  // This is exactly the shape prepublishOnly held before this packet's fix —
  // green today, and the shape of the hole this file exists to close. Built
  // through flatten() itself, from a synthetic scripts map, rather than
  // hand-typed, so this test exercises the same expansion path the real
  // checks above use rather than a hand-massaged stand-in for it.
  const preFixScripts = {
    typecheck: 'node ./node_modules/typescript/bin/tsc --noEmit',
    test: 'node --disable-warning=ExperimentalWarning --test test/*.test.ts',
    build: 'node scripts/build.mjs',
    prepublishOnly: 'npm run typecheck && npm test && npm run build',
  };
  const preFixCoverage = domainCoverage(flatten(preFixScripts, 'prepublishOnly'));
  assert.equal(preFixCoverage.root, true, 'the pre-fix gate did typecheck the root domain — that much was real');
  assert.equal(preFixCoverage.web, false, 'the pre-fix gate must be read as NOT covering the browser app');
  assert.equal(preFixCoverage.teamServer, false, 'the pre-fix gate must be read as NOT covering team-server');

  // And the positive control: a hand-built three-domain gate must read as
  // fully covered, so a false negative in the checker cannot masquerade as
  // this packet's fix being incomplete.
  const threeDomainScripts = {
    ...preFixScripts,
    prepublishOnly:
      'npm run typecheck '
      + '&& node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json '
      + '&& cd team-server && node ./node_modules/typescript/bin/tsc --noEmit && npm test '
      + '&& npm test && npm run build',
  };
  const fullCoverage = domainCoverage(flatten(threeDomainScripts, 'prepublishOnly'));
  assert.equal(fullCoverage.root, true);
  assert.equal(fullCoverage.web, true);
  assert.equal(fullCoverage.teamServer, true);
});

test('flatten() actually expands indirection rather than only reading the top-level string', () => {
  // prepublishOnly is allowed to reach a domain through an intermediate
  // script name (as it does via typecheck:all); if flatten() did not expand
  // npm run references, every check above would only ever see the top-level
  // command and a maintainer could hide a dropped domain behind a rename of
  // the indirection instead of the domain check itself.
  const scripts = {
    top: 'npm run mid && npm run build',
    mid: 'npm run leaf',
    leaf: 'node ./node_modules/typescript/bin/tsc --noEmit -p src/dashboard/web/app/tsconfig.json',
  };
  const flattened = flatten(scripts, 'top');
  assert.ok(
    flattened.includes('src/dashboard/web/app/tsconfig.json'),
    `flatten() did not expand two levels of npm run indirection: ${flattened}`,
  );
});

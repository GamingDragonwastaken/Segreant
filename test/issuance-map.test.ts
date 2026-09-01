/**
 * The issuance map is only worth what it is checked against (WP-B01, AII-036).
 *
 * A map that lives in a document drifts from the code within one packet. These
 * tests read `src/epistemic/issuance-map.ts` and the source tree together, so a
 * boundary cannot change class quietly: a `canonical` path that stops calling
 * the kernel fails, a non-canonical path that starts calling it fails, and a
 * file that issues a Claim without appearing on the map at all fails — which is
 * the case worth catching, because that is how an alternate authority actually
 * arrives. Not as a bad Claim. As one new file, correct in itself, on no map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';
import {
  ISSUANCE_MAP,
  CANONICAL_BOUNDARIES,
  LIVE_BOUNDARIES,
  UNMIGRATED_BOUNDARIES,
  UNREACHED_BOUNDARIES,
} from '../src/epistemic/issuance-map.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/** A call to the kernel's Evidence/Claim constructors, not a mention of them. */
const ISSUES_CLAIM = /(?<![A-Za-z.])claim\(\s*\{/;
const ISSUES_EVIDENCE = /(?<![A-Za-z.])evidence\(\s*\{/;

/** Every `.ts` file under `src/`, so the sweep cannot silently miss a directory. */
function sourceFiles(dir = 'src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(relative));
    else if (entry.name.endsWith('.ts')) found.push(relative);
  }
  return found;
}

/**
 * Everything under `src/` that a product entry point actually imports.
 *
 * `bin/fiscus.mjs` runs `dist/cli.js`, compiled from `src/cli.ts`, so that is
 * the entry. `team-server/` is a separate npm project that imports root source
 * directly, so its server is a second one — leaving it out would make the answer
 * depend on the accident that everything it pulls in is reachable from the CLI
 * too.
 *
 * A regex over relative specifiers is enough here and would not be in general:
 * this repository has no dynamic import with a computed specifier, which the
 * vacuity test below re-checks rather than assumes.
 */
function productClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const abs = resolve(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const source = readFileSync(abs, 'utf8');
    const specifiers = /from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = specifiers.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? '';
      // Emitted specifiers are rewritten to `.js`; the source tree is `.ts`.
      visit(join(dirname(abs), specifier.replace(/\.js$/, '.ts')));
    }
  };
  for (const entry of entries) visit(join(ROOT, entry));
  return new Set(
    [...seen]
      .map((file) => relativePath(ROOT, file).split(sep).join('/'))
      .filter((file) => file.startsWith('src/')),
  );
}

const PRODUCT_ENTRIES = ['src/cli.ts', 'team-server/src/server.ts'];

test('every mapped boundary names a module that exists', () => {
  for (const boundary of ISSUANCE_MAP) {
    assert.ok(existsSync(join(ROOT, boundary.module)), `${boundary.id}: ${boundary.module} does not exist`);
  }
});

test('boundary identifiers and modules are unique', () => {
  const ids = ISSUANCE_MAP.map((boundary) => boundary.id);
  const modules = ISSUANCE_MAP.map((boundary) => boundary.module);
  assert.equal(new Set(ids).size, ids.length, 'duplicate boundary id');
  assert.equal(new Set(modules).size, modules.length, 'one module owns one boundary');
});

test('a canonical boundary actually issues through the kernel', () => {
  for (const boundary of CANONICAL_BOUNDARIES) {
    const source = read(boundary.module);
    assert.ok(
      /from '\.\.\/epistemic\/claim\.ts'/.test(source),
      `${boundary.id} is declared canonical but does not import the kernel Claim`,
    );
    assert.ok(
      ISSUES_CLAIM.test(source) && ISSUES_EVIDENCE.test(source),
      `${boundary.id} is declared canonical but issues no Evidence/Claim pair`,
    );
  }
  assert.ok(CANONICAL_BOUNDARIES.length >= 4, 'the canonical set must not be empty or token');
});

test('a non-canonical boundary cannot mint kernel claims while declared otherwise', () => {
  // The failure this prevents: a path relabelled `display_only` or
  // `integrity_only` in the map while it goes on issuing, or an
  // `unmigrated_authority` that half-migrates and is never reclassified.
  for (const boundary of ISSUANCE_MAP) {
    if (boundary.issuanceClass === 'canonical') continue;
    const source = read(boundary.module);
    assert.ok(
      !ISSUES_CLAIM.test(source),
      `${boundary.id} is declared ${boundary.issuanceClass} but issues a kernel Claim — reclassify it or stop issuing`,
    );
  }
});

test('no file issues a kernel Claim without appearing on the map', () => {
  const mapped = new Set(ISSUANCE_MAP.map((boundary) => boundary.module));
  const undeclared: string[] = [];

  for (const relative of sourceFiles()) {
    // The kernel itself defines the constructors; it is not a product boundary.
    if (relative.startsWith('src/epistemic/')) continue;
    if (!ISSUES_CLAIM.test(read(relative))) continue;
    if (!mapped.has(relative)) undeclared.push(relative);
  }

  assert.deepEqual(
    undeclared,
    [],
    `these files issue Claims and are on no issuance map: ${undeclared.join(', ')}`,
  );
});

test('every boundary states its issuance class in its own source', () => {
  // A reader opening the file must learn what authority it holds without
  // finding the map first. `ISSUANCE CLASS: x` in the module's own docblock.
  const missing: string[] = [];
  for (const boundary of ISSUANCE_MAP) {
    const marker = new RegExp(`ISSUANCE CLASS:\\s*${boundary.issuanceClass}\\b`);
    if (!marker.test(read(boundary.module))) missing.push(`${boundary.module} (${boundary.issuanceClass})`);
  }
  assert.deepEqual(missing, [], `these modules do not declare their issuance class: ${missing.join(', ')}`);
});

test('the map records the open frontier rather than an empty one', () => {
  // AII-036 is PARTIAL. An empty unmigrated set would mean it is closed, and a
  // green test asserting that would be worse than no test at all.
  assert.ok(
    UNMIGRATED_BOUNDARIES.length > 0,
    'AII-036 is PARTIAL: if the unmigrated set is genuinely empty, close the finding rather than emptying this list',
  );
  for (const boundary of UNMIGRATED_BOUNDARIES) {
    assert.match(
      boundary.note,
      /Closing it requires|inherits its position/,
      `${boundary.id} must say what closing it requires, not merely that it is open`,
    );
  }
});

test('the program record lists exactly the boundaries the map declares', () => {
  const document = read('docs/program/ISSUANCE-MAP.md');
  const missing = ISSUANCE_MAP.filter((boundary) => !document.includes(boundary.id));
  assert.deepEqual(missing.map((b) => b.id), [], 'the published map omits a declared boundary');

  // And nothing the code does not declare: a boundary removed from the code but
  // left in the document is a claim of coverage that no longer exists.
  const documented = [...document.matchAll(/^\| `([a-z]+\.[A-Za-z]+)` \|/gm)].map((m) => m[1]!);
  const known = new Set(ISSUANCE_MAP.map((boundary) => boundary.id));
  const stale = documented.filter((id) => !known.has(id));
  assert.deepEqual(stale, [], 'the published map lists a boundary the code no longer declares');
  assert.ok(documented.length >= ISSUANCE_MAP.length, 'every boundary needs a row, not just a mention');
});

test('the sweep is not vacuous', () => {
  const files = sourceFiles();
  assert.ok(files.length > 150, `expected a full source sweep, walked ${files.length} files`);
  const issuers = files.filter((f) => !f.startsWith('src/epistemic/') && ISSUES_CLAIM.test(read(f)));
  assert.ok(issuers.length >= 4, `expected the canonical issuers to be found by the sweep, found ${issuers.length}`);
});

test('the declared reach of every boundary matches the import graph', () => {
  // Authority class says what a boundary does when it runs; reach says whether
  // anything runs it. An `unmigrated_authority` the CLI reaches can put an
  // unbacked conclusion in front of an operator today. One nothing imports
  // cannot, however wrong it would be if wired — and it is the one most likely
  // to be wired by someone who never opened the map. Both belong here; calling
  // them the same risk misdirects the work.
  const reached = productClosure(PRODUCT_ENTRIES);

  for (const boundary of ISSUANCE_MAP) {
    const actual = reached.has(boundary.module) ? 'product' : 'unreached';
    assert.equal(
      boundary.reach,
      actual,
      `${boundary.id} (${boundary.module}) is ${actual} but declared ${boundary.reach}`
        + ' — a boundary that gained or lost a consumer is a queue-position change, not a field to update quietly',
    );
  }

  assert.equal(LIVE_BOUNDARIES.length + UNREACHED_BOUNDARIES.length, ISSUANCE_MAP.length);
  assert.ok(LIVE_BOUNDARIES.length > 0, 'the map cannot claim every boundary is latent');
});

test('the reachability walk is not vacuous', () => {
  const reached = productClosure(PRODUCT_ENTRIES);

  // A walk that silently returned everything, or nothing, would make the test
  // above pass for the wrong reason in either direction.
  assert.ok(reached.size > 100, `the closure found only ${reached.size} files`);
  assert.ok(reached.has('src/cli.ts'), 'the entry point itself must be in its own closure');
  assert.ok(reached.has('src/epistemic/claim.ts'), 'the kernel must be reachable from the CLI');
  const all = sourceFiles();
  assert.ok(reached.size < all.length, 'the closure reached every source file, so it distinguishes nothing');

  // The regex walk is exact only because nothing here imports a computed
  // specifier. If that changes, the closure silently under-approximates and
  // every `unreached` verdict becomes unsound.
  for (const file of all) {
    const source = read(file);
    const dynamic = /import\(\s*[^'")\s]/.exec(source);
    assert.equal(dynamic, null, `${file}: dynamic import with a computed specifier defeats the reachability walk`);
  }
});

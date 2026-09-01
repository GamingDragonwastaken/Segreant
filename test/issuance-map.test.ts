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
import { join } from 'node:path';
import { ISSUANCE_MAP, CANONICAL_BOUNDARIES, UNMIGRATED_BOUNDARIES } from '../src/epistemic/issuance-map.ts';

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

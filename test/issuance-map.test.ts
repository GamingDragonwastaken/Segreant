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
  IMPORTED_UNINVOKED_BOUNDARIES,
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
  const documented = [...document.matchAll(/^\| `([a-z]+(?:\.[A-Za-z_]+)+)` \|/gm)].map((m) => m[1]!);
  const known = new Set(ISSUANCE_MAP.map((boundary) => boundary.id));
  const stale = documented.filter((id) => !known.has(id));
  assert.deepEqual(stale, [], 'the published map lists a boundary the code no longer declares');
  assert.ok(documented.length >= ISSUANCE_MAP.length, 'every boundary needs a row, not just a mention');
});

/**
 * MEMBERSHIP AGREEMENT IS NOT PROJECTION AGREEMENT, AND THE GAP HELD A FALSE
 * CLAIM FOR A WHOLE PACKET.
 *
 * The document above says of itself: "this page is the readable projection of
 * it, and the test fails if the two disagree in either direction". The test
 * over it compares the SET OF IDS. Every row also carries a Class and a Reach,
 * and nothing compared those — so D-184 moved `alloc.exactRun` to
 * `imported_uninvoked` in the code and left the published row reading
 * `product`, which is the exact field D-184 was written to stop overstating.
 * The prose above the table went stale in the same act: "Fifteen of the sixteen
 * boundaries are `product`" over a map of seventeen with fourteen.
 *
 * **A projection test that checks membership certifies the document's existence,
 * not its content — and the columns nobody checks are where a corrected record
 * goes to rot.** The check that would have caught it is this one, and it is
 * cheap; the reason it did not exist is that the ids were the part that felt
 * like it could drift.
 *
 * This is D-175's rule turned on the program's own documents: when you change a
 * record, search for the sentences that were true only before the change. D-184
 * changed a field and did not sweep its own projection.
 *
 * Recorded at D-188.
 */
test('every published row states the class and reach the code declares', () => {
  const document = read('docs/program/ISSUANCE-MAP.md');
  const rows = new Map<string, string>();
  for (const match of document.matchAll(/^\| `([a-z]+(?:\.[A-Za-z_]+)+)` \|(.*)$/gm)) {
    rows.set(match[1]!, match[2]!);
  }
  const disagreements: string[] = [];
  for (const boundary of ISSUANCE_MAP) {
    const row = rows.get(boundary.id);
    if (row === undefined) {
      disagreements.push(`${boundary.id}: no row`);
      continue;
    }
    // Cells, not a substring search: `product` is a substring of nothing else
    // here today, but `unreached` inside a note would satisfy a loose match and
    // the point of this test is to stop a column drifting unnoticed.
    const cells = row.split('|').map((cell) => cell.replaceAll('*', '').replaceAll('`', '').trim());
    if (!cells.includes(boundary.issuanceClass)) {
      disagreements.push(`${boundary.id}: document does not state class ${boundary.issuanceClass}`);
    }
    if (!cells.includes(boundary.reach)) {
      disagreements.push(`${boundary.id}: document does not state reach ${boundary.reach}`);
    }
  }
  assert.deepEqual(disagreements, [], 'the published projection disagrees with the map it projects');
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
    // This test owns the IMPORT axis and only that. `product` and
    // `imported_uninvoked` are both import-reachable and are separated by the
    // invocation test below, because a module can sit in the closure while no
    // product path calls into it (D-184).
    const imported = reached.has(boundary.module);
    assert.equal(
      boundary.reach !== 'unreached',
      imported,
      `${boundary.id} (${boundary.module}) is ${imported ? 'in' : 'not in'} the product import closure but declared ${boundary.reach}`
        + ' — a boundary that gained or lost a consumer is a queue-position change, not a field to update quietly',
    );
  }

  assert.equal(
    LIVE_BOUNDARIES.length + IMPORTED_UNINVOKED_BOUNDARIES.length + UNREACHED_BOUNDARIES.length,
    ISSUANCE_MAP.length,
    'the three reach states must partition the map; a fourth state added without a list here would vanish from every count',
  );
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

/**
 * A measurement rung above the bottom asserts that a validation happened. The
 * only honest way to reach one is to compute it from a record of that
 * validation, which is what `src/causal/measurement.ts` does and what
 * `src/causal/epistemic.ts` used to do by writing the word instead.
 *
 * D-153 removed the last literal. This keeps it removed: `claim()` requires a
 * non-null `measurementModelRef` above `proxy_unvalidated` and never resolves
 * it, so any non-empty string satisfies the kernel — which is exactly how a
 * synthesized reference that resolved to nothing sat behind two
 * `proxy_validated` claims for as long as it did. A literal rung at an issuance
 * boundary is the shape of that defect, and it is the shape this refuses.
 */
test('no issuance boundary writes a measurement rung above the bottom as a literal', () => {
  const LITERAL_RUNG = /measurement:\s*'(proxy_validated|validated)'/;
  const offenders: string[] = [];

  for (const relative of sourceFiles()) {
    if (relative.startsWith('src/epistemic/')) continue;
    const source = read(relative);
    if (!ISSUES_CLAIM.test(source)) continue;
    if (LITERAL_RUNG.test(source)) offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    `these files issue Claims with a hard-coded measurement rung above proxy_unvalidated, `
    + `which asserts a validation nothing records: ${offenders.join(', ')}. `
    + `Compute the rung from a measurement model and surrogate bridge instead, as src/causal/measurement.ts does.`,
  );
});

test('the literal-rung sweep would actually catch one', () => {
  // Without this the test above passes on an empty sweep, which is the failure
  // mode it exists to prevent elsewhere in this file.
  const LITERAL_RUNG = /measurement:\s*'(proxy_validated|validated)'/;
  assert.ok(LITERAL_RUNG.test("      measurement: 'proxy_validated',"));
  assert.ok(LITERAL_RUNG.test("measurement: 'validated',"));
  assert.equal(LITERAL_RUNG.test("      measurement: measurementValidation,"), false);
  assert.ok(sourceFiles().some((file) => ISSUES_CLAIM.test(read(file))), 'the sweep found no claim-issuing file at all');
});

/**
 * `reach` measures IMPORT-reachability, and the file said it measured invocation.
 *
 * The map's own prose reads "Authority class says what a boundary does when it
 * runs. It says nothing about whether anything RUNS it" and then declares
 * `reach` as the field that answers the second question. The check underneath
 * walks the import graph. Those are different questions, and a module can sit
 * in the transitive import closure of `src/cli.ts` while no product path ever
 * calls into it.
 *
 * MEASURED. `alloc.exactRun` is declared `reach: 'product'` and passes, because
 * `src/store/db.ts` imports `src/alloc/epistemic.ts`. The only caller of
 * `buildExactAllocationKernelIssuance` is `Store.saveExactAllocationRun`, and
 * the only mentions of `saveExactAllocationRun` anywhere in `src/` are its own
 * definition in `src/store/allocation.ts` and that forwarder in `db.ts`. No
 * CLI command, no dashboard route and no other module calls it. So the exact
 * allocation issuance boundary — the one on the Exact Money path AII-017 and
 * AII-018 are migrating everything toward — is declared live in the product
 * and is invoked by nothing.
 *
 * **`reach` decides queue position. A field that overstates what its check
 * establishes misdirects exactly the work the map exists to direct** — and this
 * is the file whose whole purpose is to be honest about authority, which makes
 * it the sharpest instance of the class this program keeps finding.
 *
 * WHAT THIS CHECK CAN AND CANNOT DO. It looks for the declared symbol in the
 * product closure outside the modules that define or forward it. A MENTION is
 * not a call, so this can pass on a symbol that is only imported and never
 * invoked — it proves absence of invocation, never presence. That asymmetry is
 * the right way round: it fails only when nothing in the product so much as
 * names the entry point, which cannot be a false alarm.
 *
 * The declared count below is the corpus-size assertion D-166 made a rule of.
 * Without it, a sweep that covers four boundaries and a sweep that covers none
 * are indistinguishable, and this one deliberately covers four of seventeen.
 *
 * Recorded at D-184.
 *
 * D-188 CLOSED THE GAP THE COUNT EXISTED TO KEEP VISIBLE, AND FOUND NOTHING.
 * The remaining thirteen boundaries were traced by hand — entry point by entry
 * point, each one followed to a CLI command, a dashboard route or a product
 * module — and every `product` declaration held. **A negative result, and it is
 * the point of recording it: the reason to distrust `reach` was one measured
 * instance, not a suspicion that the map was generally wrong, and the sweep
 * that clears the other sixteen is what turns that instance into a closed
 * question rather than an open doubt.**
 *
 * So the corpus assertion changes shape. `four of seventeen` was the honest
 * statement of a partial sweep; **a partial sweep's count is a placeholder for
 * a gate, and leaving it in place after the sweep completes would understate
 * what is now known.** Every boundary must declare an entry point, which makes
 * this a gate on the MAP rather than a report on the sweep: a boundary added
 * without one fails here, and cannot inherit `reach: 'product'` from the
 * import graph the way `alloc.exactRun` did.
 */
test('every boundary declares an invocation entry point, and it agrees with the declared reach', () => {
  const reached = productClosure(PRODUCT_ENTRIES);
  const undeclared = ISSUANCE_MAP.filter((b) => b.invocation === undefined);

  // The gate, replacing the partial sweep's corpus count: every boundary names
  // the symbol a product path would have to call to reach it. A new boundary
  // cannot arrive with its reach inferred from the import graph alone, which is
  // exactly how `alloc.exactRun` came to be declared live in the product while
  // nothing invoked it.
  assert.deepEqual(
    undeclared.map((b) => b.id),
    [],
    'every issuance boundary must declare the entry point a product path calls to reach it',
  );
  assert.ok(ISSUANCE_MAP.length >= 17, 'and the map must not have shrunk to make that easy');

  for (const boundary of ISSUANCE_MAP) {
    const invocation = boundary.invocation!;
    const callers = [...reached]
      .filter((file) => !invocation.definedIn.includes(file))
      .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes(invocation.symbol));
    const invoked = callers.length > 0;
    assert.equal(
      invoked,
      boundary.reach === 'product',
      `${boundary.id} declares reach '${boundary.reach}' but ${invoked ? `is named by ${callers.join(', ')}` : `no product file outside ${invocation.definedIn.join(', ')} names ${invocation.symbol}`}`
        + ' — import-reachable and invoked are different facts, and only the second decides whether an operator can meet this boundary today',
    );
  }
});

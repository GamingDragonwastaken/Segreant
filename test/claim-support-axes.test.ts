/**
 * The wire's copy of the kernel's vocabularies must be the kernel's (AII-014,
 * AII-030, WP-B02).
 *
 * The browser app compiles under its own config and cannot import node source,
 * and `src/dashboard/shared-types.ts` is copied VERBATIM into that compiler root
 * by the build, so it cannot import either. One hand-written mirror of the
 * kernel vocabularies is therefore unavoidable, and this is it. That arrangement
 * has already cost this repository once: a declaration that does not match what
 * the server actually sends type-checks perfectly and fails silently at runtime.
 * A union that drifts from its source is the same defect one level up — it would
 * compile, render, and quietly mean something the kernel does not.
 *
 * WP-B02 wrote a SECOND mirror in `core/claimTypes.ts`. That one is gone: the
 * axes are on the wire now, so the browser imports the generated copy and there
 * is nothing left there to drift. These tests read the remaining mirror and the
 * kernel and compare the members, so the two cannot diverge without a failure.
 * They also pin the thing WP-B02 removed: a claim's support is stated on named
 * axes, and `established: boolean` cannot come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

/** Pull the string members out of a `const X = ['a', 'b'] as const;` declaration. */
function kernelMembers(source: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${name} not found in the kernel source`);
  return [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** Pull the members out of a wire `export type X = 'a' | 'b';` declaration. */
function wireMembers(source: string, name: string): string[] {
  const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  assert.ok(match, `${name} not found in the browser source`);
  return [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

test('the wire axis vocabularies are exactly the kernel’s', () => {
  const state = read('src', 'epistemic', 'state.ts');
  const profile = read('src', 'epistemic', 'profile.ts');
  const wire = read('src', 'dashboard', 'shared-types.ts');

  const pairs: Array<[string, string[], string[]]> = [
    ['epistemic state', kernelMembers(state, 'EPISTEMIC_STATES'), wireMembers(wire, 'ClaimEpistemicState')],
    ['coverage', kernelMembers(profile, 'COVERAGE'), wireMembers(wire, 'ClaimCoverageStatus')],
    ['monetary basis', kernelMembers(profile, 'MONETARY_BASIS'), wireMembers(wire, 'ClaimMonetaryBasis')],
  ];

  for (const [label, kernel, mirrored] of pairs) {
    assert.ok(kernel.length > 0, `${label}: the kernel extraction is vacuous`);
    assert.deepEqual(
      mirrored,
      kernel,
      `${label}: the wire mirror has drifted from src/epistemic/ — same members, same order`,
    );
  }
});

test('the browser holds no second mirror of the axes', () => {
  // WP-B02's hand-written unions in `core/claimTypes.ts` are re-exports of the
  // generated wire copy now. If someone writes the members out again — for a
  // quick fix, or to add one axis — the drift test above stops covering the
  // declaration the GUI actually compiles against.
  const types = read('src', 'dashboard', 'web', 'app', 'core', 'claimTypes.ts');
  assert.match(types, /from '\.\/generated-types\.ts'/, 'the browser axes must come from the generated wire copy');
  assert.doesNotMatch(
    types,
    /export type Layer(?:EpistemicState|Coverage|MonetaryBasis|Figure)\s*=\s*'/,
    'the browser must not re-declare an axis union it imports',
  );
});

test('a layer states its support on axes, and the collapsed boolean cannot return', () => {
  // AII-014. `src/epistemic/profile.ts` opens by saying a claim is never
  // reduced to `established: boolean`. The spine was doing it anyway, and the
  // one bit stood for three different questions at once.
  const types = read('src', 'dashboard', 'web', 'app', 'core', 'claimTypes.ts');
  const layers = read('src', 'dashboard', 'web', 'app', 'core', 'claimLayers.ts');
  const spine = read('src', 'dashboard', 'web', 'app', 'components', 'spine.ts');
  const inspector = read('src', 'dashboard', 'web', 'app', 'components', 'claimInspector.ts');
  const wire = read('src', 'dashboard', 'shared-types.ts');
  const server = read('src', 'dashboard', 'claim-support.ts');

  for (const [name, source] of [
    ['claimTypes', types], ['claimLayers', layers], ['spine', spine], ['inspector', inspector],
    ['shared-types', wire], ['claim-support', server],
  ] as const) {
    assert.doesNotMatch(
      source,
      /(?<![A-Za-z`])established\s*[:?]\s*boolean|\.established\b/,
      `${name} must not carry or read a collapsed established boolean`,
    );
  }

  const payload = /export interface ClaimSupportPayload \{([\s\S]*?)\n\}/.exec(wire);
  assert.ok(payload, 'ClaimSupportPayload not found on the wire');
  assert.match(payload[1]!, /epistemic: ClaimEpistemicState/);
  assert.match(payload[1]!, /coverage: ClaimCoverageStatus/);
  assert.match(payload[1]!, /monetaryBasis: ClaimMonetaryBasis/);
  assert.match(payload[1]!, /figure: ClaimFigureStatus/);

  // And not a score in its place: one number between 0 and 1 is the same
  // collapse with a decimal point.
  assert.doesNotMatch(payload[1]!, /confidence\s*[:?]\s*number|score\s*[:?]\s*number/i);
  assert.doesNotMatch(types, /confidence\s*[:?]\s*number|score\s*[:?]\s*number/i);
});

test('the call sites ask named questions rather than one bit', () => {
  const spine = read('src', 'dashboard', 'web', 'app', 'components', 'spine.ts');
  const inspector = read('src', 'dashboard', 'web', 'app', 'components', 'claimInspector.ts');

  // Whether the claim holds and whether a figure is shown are separate calls.
  for (const [name, source] of [['spine', spine], ['inspector', inspector]] as const) {
    assert.match(source, /claimIsSupported\(/, `${name} must ask whether the claim is supported by name`);
    assert.match(source, /claimShowsFigure\(/, `${name} must ask whether a figure is shown separately`);
  }

  // The spine says the uncosted case out loud rather than counting it as open.
  assert.match(spine, /claimIsSupportedButUncosted/);
});

test('the spine does not call a contradiction an absence of evidence', () => {
  // The summary line ends "an absence of evidence, never a measured zero". That
  // sentence is TRUE of an unevidenced claim and FALSE of a contradicted one,
  // and it used to be produced from a `!claimIsSupported` partition — which put
  // both in it. Nothing could reach the second state until the axes moved to the
  // wire, so this is a defect that arrived with the fix and had to go with it.
  const spine = read('src', 'dashboard', 'web', 'app', 'components', 'spine.ts');

  assert.match(spine, /absence of evidence/, 'the sentence this test is about must still exist');
  assert.match(spine, /claimIsUnevidenced/, 'the unsubstantiated line must be scoped to unevidenced claims');
  assert.doesNotMatch(
    spine,
    /!claimIsSupported\(/,
    'partitioning on NOT-supported puts contradicted and refuted claims in the absence sentence',
  );
  assert.match(spine, /claimIsConflicted/, 'a contradicted claim must get its own sentence');
  assert.match(spine, /claimIsRefuted/, 'a refuted claim is a measured answer, not a gap');

  // And the three lines must be visually distinguishable, or the distinction
  // only exists in the source.
  const css = read('src', 'dashboard', 'web', 'styles', 'app.css');
  for (const cls of ['.spine-uncosted', '.spine-conflicted', '.spine-refuted']) {
    assert.ok(css.includes(cls), `${cls} has no style, so it reads as the line above it`);
  }
});

test('the Evidence headline is keyed on the claim, not on a records-level constant', () => {
  // `handleBilling` sends `evidence.reconciliationStatus` as a CONSTANT
  // 'not_reconciled' describing the trust posture of the held import records.
  // This card, titled "Reconciliation status", rendered it with the gloss
  // "no observation run recorded" — so it said that with a run recorded and
  // described four lines below. A collapsed status field read as a claim's
  // state, which is the defect the whole packet is about.
  const evidence = read('src', 'dashboard', 'web', 'app', 'views', 'evidence.ts');

  assert.match(evidence, /claimSupport\?\.epistemic/, 'the headline must read the claim state from the wire');
  assert.doesNotMatch(
    evidence,
    /STATUS_WORDS\[d\.evidence\.reconciliationStatus\]/,
    'the headline must not be keyed on the records-level constant',
  );
  assert.doesNotMatch(
    evidence,
    /no observation run recorded'/,
    'that gloss is false whenever a run exists, which is exactly when this card is read',
  );
  // Every four-valued state needs a word, or one of them falls through to a
  // sentence written for a different state.
  for (const state of ['unknown', 'supported', 'refuted', 'conflicted']) {
    assert.ok(evidence.includes(`\n  ${state}: {`), `no headline words for ${state}`);
  }
});

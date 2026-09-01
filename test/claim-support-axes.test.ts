/**
 * The browser's copy of the kernel's vocabularies must be the kernel's (AII-014,
 * AII-030, WP-B02).
 *
 * The browser app compiles under its own config and cannot import node source,
 * so `core/claimTypes.ts` hand-writes the axis unions that `src/epistemic/`
 * owns. That arrangement has already cost this repository once: a declaration
 * that does not match what the server actually sends type-checks perfectly and
 * fails silently at runtime. A hand-written union that drifts from its source
 * is the same defect one level up — it would compile, render, and quietly mean
 * something the kernel does not.
 *
 * These tests read both files as text and compare the members, so the two
 * cannot diverge without a failure. They also pin the thing WP-B02 removed: a
 * layer's support is stated on named axes, and `established: boolean` cannot
 * come back.
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

/** Pull the members out of a browser `export type X = 'a' | 'b';` declaration. */
function browserMembers(source: string, name: string): string[] {
  const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  assert.ok(match, `${name} not found in the browser source`);
  return [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

test('the browser axis vocabularies are exactly the kernel’s', () => {
  const state = read('src', 'epistemic', 'state.ts');
  const profile = read('src', 'epistemic', 'profile.ts');
  const browser = read('src', 'dashboard', 'web', 'app', 'core', 'claimTypes.ts');

  const pairs: Array<[string, string[], string[]]> = [
    ['epistemic state', kernelMembers(state, 'EPISTEMIC_STATES'), browserMembers(browser, 'LayerEpistemicState')],
    ['coverage', kernelMembers(profile, 'COVERAGE'), browserMembers(browser, 'LayerCoverage')],
    ['monetary basis', kernelMembers(profile, 'MONETARY_BASIS'), browserMembers(browser, 'LayerMonetaryBasis')],
  ];

  for (const [label, kernel, mirrored] of pairs) {
    assert.ok(kernel.length > 0, `${label}: the kernel extraction is vacuous`);
    assert.deepEqual(
      mirrored,
      kernel,
      `${label}: the browser mirror has drifted from src/epistemic/ — same members, same order`,
    );
  }
});

test('a layer states its support on axes, and the collapsed boolean cannot return', () => {
  // AII-014. `src/epistemic/profile.ts` opens by saying a claim is never
  // reduced to `established: boolean`. The spine was doing it anyway, and the
  // one bit stood for three different questions at once.
  const types = read('src', 'dashboard', 'web', 'app', 'core', 'claimTypes.ts');
  const layers = read('src', 'dashboard', 'web', 'app', 'core', 'claimLayers.ts');
  const spine = read('src', 'dashboard', 'web', 'app', 'components', 'spine.ts');
  const inspector = read('src', 'dashboard', 'web', 'app', 'components', 'claimInspector.ts');

  for (const [name, source] of [['claimTypes', types], ['claimLayers', layers], ['spine', spine], ['inspector', inspector]] as const) {
    assert.doesNotMatch(
      source,
      /(?<![A-Za-z`])established\s*[:?]\s*boolean|\.established\b/,
      `${name} must not carry or read a collapsed established boolean`,
    );
  }

  assert.match(types, /readonly epistemic: LayerEpistemicState/);
  assert.match(types, /readonly coverage: LayerCoverage/);
  assert.match(types, /readonly monetaryBasis: LayerMonetaryBasis/);
  assert.match(types, /readonly figure: LayerFigure/);

  // And not a score in its place: one number between 0 and 1 is the same
  // collapse with a decimal point.
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

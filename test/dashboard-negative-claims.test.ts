/**
 * The dashboard's two absence claims, brought to the same standard as the CLI
 * (WP-D06, WP-R04).
 *
 * THE REMAINDER D-140 AND D-141 LEFT OPEN. Both defects had two surfaces. The
 * CLI half was repaired first; the browser half was deliberately not edited
 * concurrently, and this closes it.
 *
 * THE WORSE OF THE TWO PHRASINGS WAS HERE. `views/value.ts` rendered, in
 * plain-language mode:
 *
 *   The rate is holding steady — no sign it is drifting.
 *
 * with no `n` at all. The precise mode was better — it named `n` — but still led
 * with "No drift detected", which is a finding. Neither is available: the drift
 * e-process bounds FALSE alarms and says nothing about missed ones, and the
 * measurement recorded at D-140 shows a total regime change (rate 0, then rate 1)
 * does not fire it at n=10 or n=20, which is exactly the range where the watch
 * first speaks.
 *
 * THE WIRE COULD NOT CARRY THE ANSWER EITHER. `drift` was declared as
 * `{ n, alarm, recentRate?, overallRate? }`. Nothing on it distinguishes "the
 * detectors ran and stayed quiet" from "the alarm could not have fired", so the
 * browser had no way to be honest even if its copy had been. Both halves are
 * fixed together, because fixing the sentence alone would have hidden the gap
 * rather than closed it.
 *
 * AND THE ALERTS PANEL HAD THE SAME SHAPE AS `fiscus ops`. `computeAlerts`
 * returns a bare array and the overview forwarded it, so an empty list reached
 * the browser with no statement of how many detectors could have produced an
 * entry. On a default install all six are dark. The overview now carries the
 * coverage alongside the alerts, on the same principle that settled the budget
 * basis: the declaration takes the producer's own value structurally, so the two
 * cannot drift apart without a type error. Recorded at D-144.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app');

function read(...parts: string[]): string {
  return readFileSync(join(APP, ...parts), 'utf8');
}

test('the value view no longer tells the operator the rate is holding steady', () => {
  const source = read('views', 'value.ts');
  assert.doesNotMatch(source, /holding steady/i);
  assert.doesNotMatch(source, /no sign it is drifting/i);
  assert.doesNotMatch(source, /No drift detected/i);
});

test('the quiet branch says what happened and over how many units, in both modes', () => {
  // Precise mode already named `n`; plain-language mode named nothing at all,
  // which is how the worse sentence came to be the reassuring one.
  const source = read('views', 'value.ts');
  const quiet = source.slice(source.indexOf('drift.alarm'));
  assert.match(quiet, /did not fire|no alarm/i, 'the quiet branch reports the absence of a result');
  assert.match(quiet, /drift\.n/, 'and how many units it did not fire over');
});

test('the wire carries whether the alarm could have fired, not only whether it did', () => {
  // A sentence repaired over a payload that cannot express the distinction would
  // hide the gap rather than close it.
  const shared = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts'), 'utf8');
  const generated = readFileSync(join(APP, 'core', 'generated-types.ts'), 'utf8');
  for (const [name, source] of [['shared-types', shared], ['generated-types', generated]] as const) {
    assert.match(source, /referenceDriftWouldFire/, `${name} must carry the detectability of the drift watch`);
  }
});

test('the overview carries alert coverage beside the alerts themselves', () => {
  const shared = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'shared-types.ts'), 'utf8');
  const routes = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'routes.ts'), 'utf8');
  assert.match(shared, /alertCoverage/, 'the payload declares the coverage');
  assert.match(routes, /computeAlertCoverage/, 'and the server fills it from the producer rather than recomputing it');
});

test('both new fields reach the generated browser copy, not just the shared source', () => {
  // THE FAILURE MODE THIS APP IS MOST PRONE TO. The browser cannot import node
  // source, so it compiles against a generated copy; a declaration that does not
  // match the wire type-checks perfectly and fails silently at runtime — that is
  // how `reconciliation.runs` came to be declared a number while the server sent
  // an array. The hash binding the copy to its source is pinned by
  // `test/dashboard-shared-types.test.ts`; what is asserted here is that these
  // two particular fields survived the generator, since a field the browser
  // cannot see is a field no view can be honest with.
  const generated = read('core', 'generated-types.ts');
  assert.match(generated, /referenceDriftWouldFire\?: boolean/);
  assert.match(generated, /alertCoverage\?: \{/);
  assert.match(generated, /darkBecause: string \| null/);
});

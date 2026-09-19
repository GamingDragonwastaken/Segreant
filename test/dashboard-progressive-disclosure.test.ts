/**
 * PROGRESSIVE DISCLOSURE IS DECIDED AND PRESENTATION FOLLOWS THE AXES
 * (WP-I03, D-256).
 *
 * The decision, stated so it can be tested: a first-run operator is shown ONE
 * thing — the plain/precise choice — and nothing else routes until they have
 * chosen; `plain` states every figure rounded with its basis in words, and
 * `precise` states the same figure to the microdollar with the provenance
 * label and the equivalent command; the `consequence` axis of every capability
 * is rendered as a tag whenever it is anything but `read`, and the `territory`
 * axis is what the operations bar and the System table are built from.
 *
 * This gate reads the register-sensitive formatters under both registers and
 * reads the shell and view sources for the three structural rules. It does
 * not render a browser; the interaction tests hold the modal's focus policy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, TERRITORIES, type Consequence } from '../src/dashboard/web/app/core/registry.ts';
import { basisWords, register, setRegister, usd, usdFromMicros } from '../src/dashboard/web/app/core/fmt.ts';

const WEB = join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app');
const read = (rel: string): string => readFileSync(join(WEB, rel), 'utf8');

test('a first-run operator is shown the register choice and nothing else routes until they choose', () => {
  assert.equal(register(), null, 'under node nothing is stored, which is the first-run state');
  const main = read('main.ts');
  const gate = main.indexOf('if (!registerChosen()) {');
  assert.ok(gate > 0, 'the shell gates on the register having been chosen');
  const afterGate = main.slice(gate, gate + 120);
  assert.match(afterGate, /render\(root, firstRun\(\)\);\s*return;/, 'first run renders the choice and returns before the shell');
  assert.ok(main.indexOf('render(root,\n') > gate, 'the shell renders only after the gate');
  const firstRun = main.slice(main.indexOf('function firstRun()'), main.indexOf('function topbar()'));
  assert.match(firstRun, /setRegister\('plain'\)/);
  assert.match(firstRun, /setRegister\('precise'\)/);
  assert.match(firstRun, /loads nothing from the internet/, 'the first screen states the local-only boundary before anything is shown');
});

test('plain rounds and explains; precise states the microdollar and the provenance label', () => {
  setRegister('plain');
  assert.equal(usd(59.163468), '$59.16');
  assert.equal(usdFromMicros(59_163_468), '$59.16');
  assert.equal(basisWords('client_declared'), 'the tool told us');
  setRegister('precise');
  assert.equal(usd(59.163468), '$59.163468');
  assert.equal(usdFromMicros(59_163_468), '$59.163468');
  assert.match(basisWords('client_declared'), /^client_declared — /, 'precise leads with the label itself');
  assert.match(basisWords('legacy_unknown'), /legacy_unknown/);
  setRegister('plain');
  assert.doesNotMatch(basisWords('legacy_unknown'), /legacy_unknown/, 'plain never shows a raw sentinel');
});

test('the consequence axis is rendered on every non-read action and the command only under precise', () => {
  const spend = read('views/spend.ts');
  const card = spend.slice(spend.indexOf('export function actionCard('));
  assert.match(card, /cap\.consequence !== 'read'\s*\?\s*h\('span', \{ class: `tag tag-\$\{cap\.consequence\}`/);
  assert.match(card, /register\(\) === 'precise' \? h\('span', \{ class: 'tag', text: cap\.command/);
  const consequences = new Set<Consequence>(CAPABILITIES.map((c) => c.consequence));
  for (const consequence of ['local', 'credential', 'egress', 'destructive'] as const) {
    assert.ok(consequences.has(consequence), `the registry declares a ${consequence} capability for the tag rule to apply to`);
  }
  const css = readFileSync(join(WEB, '..', 'styles', 'app.css'), 'utf8');
  for (const consequence of consequences) {
    if (consequence === 'read') continue;
    assert.ok(css.includes(`.tag-${consequence}`), `the ${consequence} tag has a style, so the axis is visible and not only present`);
  }
});

test('the territory axis builds the operations bar and the System table', () => {
  const main = read('main.ts');
  assert.match(main, /OPERATIONS\.map\(\(op\) => h\('button'/);
  const system = read('views/system.ts');
  assert.match(system, /TERRITORIES\.find\(\(t\) => t\.id === c\.territory\)\?\.label/);
  const territories = new Set(TERRITORIES.map((t) => t.id));
  for (const capability of CAPABILITIES) {
    assert.ok(territories.has(capability.territory), `${capability.id} sits in a declared territory`);
  }
});

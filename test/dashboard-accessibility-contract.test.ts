import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'src', 'dashboard', 'web', 'app');

test('modern metered ledger exposes table semantics and announced loading/error states', () => {
  const spend = readFileSync(join(APP, 'views', 'spend.ts'), 'utf8');
  assert.match(spend, /role: 'table'/);
  assert.match(spend, /role: 'columnheader'/);
  assert.match(spend, /role: 'cell'/);
  assert.match(spend, /role: 'alert'/);
  assert.match(spend, /aria-live': 'assertive'/);
  assert.match(spend, /role: 'status'/);
  assert.match(spend, /aria-busy': 'true'/);
});

test('classic dashboard exposes current view/range state and an accessible chart summary', () => {
  const classic = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
  assert.match(classic, /nav class="viewnav"[^>]*aria-label="Classic dashboard views"/);
  assert.match(classic, /data-view="overview"[^>]*aria-current="page"/);
  assert.match(classic, /class="ranges"[^>]*role="group"[^>]*aria-label="Time range"/);
  assert.match(classic, /data-r="today"[^>]*aria-pressed="true"/);
  assert.match(classic, /<svg[^>]*role="img"[^>]*aria-labelledby="spend-chart-title spend-chart-desc"/);
  assert.match(classic, /<title id="spend-chart-title">/);
  assert.match(classic, /<desc id="spend-chart-desc">/);
});

/**
 * The skip link is the only navigation aid in the shell that exists solely for
 * keyboard and screen-reader operators, and it was the one control that could
 * throw them off the screen they were reading.
 *
 * `href="#main"` is a fragment, so following it writes `#main` into
 * `location.hash`. The shell routes on the hash: `hashchange` runs `readRoute()`,
 * `'main'` is not in `ALL_ROUTES`, and the fallback is `'spend'`. Pressing Tab
 * then Enter on Realized therefore navigated to Metered — a keyboard-only
 * regression of the current view, in the control whose whole purpose is to help
 * keyboard users.
 */
test('the skip link moves focus without going through the hash router', () => {
  const main = readFileSync(join(APP, 'main.ts'), 'utf8');

  // The counterexample, asserted rather than described: '#main' is not a route,
  // so letting the browser apply the href cannot leave the route alone.
  const routes = /const ALL_ROUTES: Territory\[\] = \[([^\]]*)\]/.exec(main)?.[1] ?? '';
  assert.ok(routes.length > 0, 'ALL_ROUTES is still the route whitelist');
  assert.doesNotMatch(routes, /'main'/);

  assert.match(main, /class: 'skip'[\s\S]{0,400}?event\.preventDefault\(\)/);
  assert.match(main, /class: 'skip'[\s\S]{0,400}?focus\(\)/);
});

/**
 * A commit is the only thing in this GUI that changes state, and its outcome was
 * the one message nothing announced.
 *
 * The result rendered as a bare `<p>` inside the footer's reactive region, and
 * the same signal that produced it disabled the commit button (`result() === null`
 * is part of `ready`). So at the instant the outcome existed, the operator's
 * focus was dropped from a control that had just become disabled, and the only
 * report of what happened was inert text. A region created together with its own
 * content is not reliably spoken either — the region has to predate the message.
 */
test('a drawer commit reports its outcome through a live region that predates the outcome', () => {
  const drawer = readFileSync(join(APP, 'components', 'drawer.ts'), 'utf8');

  assert.match(drawer, /class: 'drawer-result'[\s\S]{0,200}role: 'status'/);
  assert.match(drawer, /class: 'drawer-result'[\s\S]{0,200}'aria-live': 'polite'/);
  // The reactive result must live INSIDE the region, not be the thing that
  // creates it.
  assert.match(drawer, /class: 'drawer-result'[\s\S]{0,400}const r = result\(\)/);
});

/**
 * Detection is the one deliberate, operator-triggered read on the Data screen,
 * and it reported nothing to anyone not watching the pixels.
 *
 * `runDetect` flips `scanning`, then lands four counts in a `card` built fresh by
 * the reactive region. Only the failure path carried `role="alert"`; success was
 * silent, and so was the wait. The region now exists before the run, so the
 * transition from "Looking…" to counts is a status message rather than a
 * silent repaint.
 */
test('running detection announces its progress and result through a persistent region', () => {
  const data = readFileSync(join(APP, 'views', 'data.ts'), 'utf8');

  assert.match(data, /class: 'scan-result'[\s\S]{0,200}role: 'status'/);
  assert.match(data, /class: 'scan-result'[\s\S]{0,200}'aria-live': 'polite'/);
  assert.match(data, /class: 'scan-result'[\s\S]{0,240}'aria-busy': \(\) => \(scanning\(\)/);
});

/**
 * The daily cap is the only free-text field in the GUI and the only one whose
 * empty and zero values mean opposite things: empty changes nothing, `0` blocks
 * all spend. That sentence sat in a sibling `<p>` with no association to the
 * input, so an operator who tabbed straight to the field heard "New daily limit,
 * in dollars" and nothing else. Instructions that carry a consequence have to
 * reach the control they govern.
 */
test('the daily-cap field carries its consequence as a programmatic description', () => {
  const actions = readFileSync(join(APP, 'core', 'actions.ts'), 'utf8');

  // The description has to hang off the input itself, not merely exist beside
  // it, so both halves are asserted in one window rather than independently.
  assert.match(actions, /id: 'budget-cap-input'[\s\S]{0,1200}'aria-describedby': 'budget-cap-note'/);
  assert.match(actions, /id: 'budget-cap-note'[\s\S]{0,200}Enter 0 to block all spend/);
});

/**
 * WP-I04 remainder: accessibility defects the prior tranche of this packet
 * named but had no scope left to close (see `docs/program/
 * PACKET-INVENTORY.md`, WP-I04's PARTIAL row). Like the rest of the
 * accessibility contract suite, these tests read SOURCE, not a rendered DOM —
 * this repository has zero runtime dependencies (only `typescript` and
 * `@types/node` as devDependencies), Node ships no DOM implementation, and
 * pulling in jsdom/puppeteer/happy-dom to get one would itself violate that
 * rule. So these assertions prove the markup and CSS this app emits carry the
 * right roles, attributes and heading levels — not that a browser's
 * accessibility tree actually renders them that way. No runtime
 * accessibility was observed here either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CSS = join(ROOT, 'src', 'dashboard', 'web', 'styles', 'app.css');

/**
 * Defect 1: `app.css` hid `.ledger-head` with `display: none` under the
 * 820px breakpoint. `display: none` removes an element from the
 * accessibility tree entirely, not just from the screen — so on a narrow
 * viewport the `role="columnheader"` cells the head row carries (see the
 * Metered ledger) vanished along with it, leaving `role="row"` body cells
 * under a `role="table"` with no headers at all. The fix keeps the row
 * present but visually collapsed via clipping, which hides it on screen
 * without touching the accessibility tree.
 */
test('defect 1: the narrow-width ledger header stays in the accessibility tree while hidden on screen', () => {
  const css = readFileSync(CSS, 'utf8');

  // app.css has more than one `@media (max-width: 820px)` block; the one that
  // matters here is identified by content (it also reflows `.ledger-row`),
  // not by position, and extracted by brace counting so a nested rule's own
  // `}` cannot be mistaken for the media query's closing brace.
  const marker = css.indexOf(".ledger-row {\n    grid-template-columns: minmax(0, 1fr) auto;");
  assert.ok(marker > -1, 'the narrow-width ledger-row reflow rule exists in app.css');
  const mediaStart = css.lastIndexOf('@media', marker);
  assert.ok(mediaStart > -1, 'a preceding @media block wraps the narrow-width ledger rules');
  const openBrace = css.indexOf('{', mediaStart);
  let depth = 0;
  let mediaEnd = -1;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) { mediaEnd = i; break; }
    }
  }
  assert.ok(mediaEnd > openBrace, 'the narrow-width @media block is well-formed');
  const media = css.slice(openBrace + 1, mediaEnd);

  const headRule = /\.ledger-head\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
  assert.ok(headRule.length > 0, '.ledger-head has a rule inside the narrow-width block');

  // The counterexample: `display: none` removes the row (and its
  // columnheader children) from the accessibility tree, not merely the
  // screen.
  assert.doesNotMatch(headRule, /display:\s*none/, '.ledger-head must not be display:none at narrow widths — that strips its columnheader cells from the accessibility tree');
  // It must instead use a clip-based hide, which keeps the row (and its
  // ARIA roles) in the tree while collapsing it visually.
  assert.match(headRule, /clip:\s*rect\(0,?\s*0,?\s*0,?\s*0\)/, '.ledger-head should hide via clipping, not display/visibility, to stay screen-reader-accessible at narrow widths');
});

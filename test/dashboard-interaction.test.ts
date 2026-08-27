import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WEB = join(ROOT, 'src', 'dashboard', 'web');

test('the budget action explains that a saved cap is enforced immediately', () => {
  const source = readFileSync(join(WEB, 'app', 'core', 'actions.ts'), 'utf8');

  assert.match(source, /label: 'Takes effect'[\s\S]{0,180}value: 'immediately'/);
  assert.match(source, /running proxy uses the saved cap/);
  assert.doesNotMatch(source, /on proxy restart|until it is restarted|Restart Fiscus for the proxy/);
});

test('the first-run choice is a keyboard-managed modal with a non-dismissal Escape policy', () => {
  const source = readFileSync(join(WEB, 'app', 'main.ts'), 'utf8');

  assert.match(source, /function firstRun\(\)/);
  assert.match(source, /tabindex: '-1'/);
  assert.match(source, /trapFocus\(body/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /restoreFocus\(/);
});

test('action and evidence overlays restore their opener and clean up with the host scope', () => {
  const drawer = readFileSync(join(WEB, 'app', 'components', 'drawer.ts'), 'utf8');
  const inspector = readFileSync(join(WEB, 'app', 'components', 'claimInspector.ts'), 'utf8');

  assert.match(drawer, /onCleanup\(/);
  assert.match(drawer, /restoreFocus\(/);
  assert.doesNotMatch(drawer, /effect\(\(\) => \{\s*if \(open\(\) === null\)/);
  assert.match(inspector, /onCleanup\(/);
  assert.match(inspector, /restoreFocus\(/);
});

test('the classic dashboard names its legacy contract and keeps settings failures visible', () => {
  const classic = readFileSync(join(WEB, 'classic.html'), 'utf8');
  const context = readFileSync(join(ROOT, 'src', 'dashboard', 'CONTEXT.md'), 'utf8');

  assert.match(classic, /legacy compatibility view/i);
  assert.match(classic, /does not provide the modern preview-first action flow/i);
  assert.match(context, /Classic is an explicitly legacy compatibility view/i);
  assert.match(context, /must\s+not\s+be\s+presented\s+as\s+GUI parity/i);
  assert.match(classic, /settings-error/);
  assert.match(classic, /res\.ok/);
  assert.match(classic, /Try again/);
});

test('focus restoration skips an opener removed from the document', async () => {
  const { restoreFocus } = await import('../src/dashboard/web/app/core/focus.ts');
  let focused = false;
  restoreFocus({ isConnected: false, focus: () => { focused = true; } });
  assert.equal(focused, false);
});

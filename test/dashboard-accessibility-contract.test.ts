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

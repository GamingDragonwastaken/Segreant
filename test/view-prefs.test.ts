/**
 * "What you see" preferences are read back defensively: a stored value from an
 * older build, a hand-edited one, or garbage must fall back field by field to
 * the defaults, never to a blank or half-hidden page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseViewPrefs, VIEW_DEFAULTS } from '../src/dashboard/web/app/core/view.ts';
import { JOBS } from '../src/dashboard/web/app/core/jobs.ts';

test('nothing stored means everything shown, comfortable', () => {
  assert.deepEqual(parseViewPrefs(null), VIEW_DEFAULTS);
});

test('garbage and wrong types fall back field by field', () => {
  assert.deepEqual(parseViewPrefs('not json'), VIEW_DEFAULTS);
  const odd = parseViewPrefs(JSON.stringify({ density: 'tiny', strip: 'no', intros: 0, hiddenJobs: ['spend', 4, null] }));
  assert.equal(odd.density, 'comfortable', 'an unknown density is not applied');
  assert.equal(odd.strip, true, 'only an explicit false hides the strip');
  assert.equal(odd.intros, true);
  assert.deepEqual(odd.hiddenJobs, ['spend'], 'non-string job ids are dropped');
});

test('explicit choices survive the round trip', () => {
  const p = parseViewPrefs(JSON.stringify({ density: 'compact', strip: false, intros: false, hiddenJobs: ['allocation'] }));
  assert.deepEqual(p, { density: 'compact', strip: false, intros: false, hiddenJobs: ['allocation'] });
});

test('the shared job list is the six jobs, in top-bar order', () => {
  assert.deepEqual(JOBS.map((j) => j.label), ['Statement', 'Spend', 'Protect', 'Close', 'Allocate', 'Value']);
});

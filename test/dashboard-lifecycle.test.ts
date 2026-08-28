import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effect, onCleanup, scopedEffect, signal } from '../src/dashboard/web/app/core/signal.ts';

const ROOT = join(import.meta.dirname, '..');

test('scopedEffect is disposed with its enclosing reactive render scope', () => {
  const source = signal(0);
  let runs = 0;
  let cleanups = 0;
  const disposeOuter = effect(() => {
    scopedEffect(() => {
      source();
      runs += 1;
      onCleanup(() => { cleanups += 1; });
    });
  });

  source.set(1);
  assert.equal(runs, 2);
  disposeOuter();
  source.set(2);
  assert.equal(runs, 2, 'a disposed render scope must not retain child subscriptions');
  assert.equal(cleanups, 2, 'one cleanup belongs to the rerun and one to final disposal');
});

test('spend view cancels and sequences range requests before accepting a response', () => {
  const source = readFileSync(join(ROOT, 'src', 'dashboard', 'web', 'app', 'views', 'spend.ts'), 'utf8');
  assert.match(source, /scopedEffect\(/);
  assert.match(source, /AbortController/);
  assert.match(source, /payload\.range/);
  assert.match(source, /onCleanup\(/);
  assert.match(source, /data\.set\(null\)/);
});

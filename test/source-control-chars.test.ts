/**
 * No raw control characters in source, except the few that are deliberate.
 *
 * Patch scripts that pass `\2...` or `\b` through a Python string turn a CSS
 * escape into chr(0x15) and a regex word boundary into a backspace byte. Both
 * have happened: the Settings disclosure marker rendered as a tofu box, and a
 * `doesNotMatch` guard in publication-lock-race silently stopped checking three
 * of its four patterns. Neither changed a single test result, so nothing else
 * would have caught them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCANNED = ['src', 'test', 'scripts', 'bin', 'team-server/src', 'team-server/test'];
const TEXT = /\.(ts|mts|mjs|js|css|html|json|md)$/;

// Deliberate raw bytes: a NUL as an identity delimiter that no label can
// contain, and a control-character class written literally. Each entry is
// path:line, so a moved or new occurrence must be looked at again.
const DELIBERATE = new Set([
  'src/alloc/apply.ts:201',
  'src/alloc/rules.ts:93',
  'src/connect/importShared.ts:319',
  'test/dashboard-coverage-value.test.ts:97',
  'test/economic-conservation-laws.test.ts:387',
]);

function* files(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (TEXT.test(name)) yield full;
  }
}

test('source files carry no stray control characters', () => {
  const found: string[] = [];
  for (const top of SCANNED) {
    for (const file of files(join(ROOT, top))) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) {
          const where = `${relative(ROOT, file).split(sep).join('/')}:${i + 1}`;
          if (!DELIBERATE.has(where)) found.push(where);
        }
      });
    }
  }
  assert.deepEqual(found, [], 'a control character here is almost always a mangled escape (\\b, \\25B8, \\0); write the escape, not the byte');
});

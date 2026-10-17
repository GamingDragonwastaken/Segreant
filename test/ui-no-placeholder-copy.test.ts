/**
 * Shipped screens describe what works now. Launch-bar L1 ("no 'coming soon',
 * no TODO copy in shipped UI") found the drawer for a command-line-only job
 * saying the screen was "not built yet": a promise, not a fact. Code comments
 * are excluded; only text a user could read is checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROMISES = /coming soon|not built yet|not (?:yet )?wired|does not have a screen yet|can do it yet|\bTODO\b|\bFIXME\b|\bTBD\b|lorem ipsum|not implemented/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|html)$/.test(name) ? [path] : [];
  });
}

test('no shipped dashboard text promises an unbuilt feature', () => {
  const hits: string[] = [];
  for (const file of [...files('src/dashboard/web/app'), 'src/dashboard/web/index.html', 'src/dashboard/web/classic.html']) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      const text = code.replace(/\/\/.*$/, '');
      if (PROMISES.test(text)) hits.push(`${file}:${i + 1}: ${code.slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

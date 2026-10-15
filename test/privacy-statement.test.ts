/**
 * The privacy statement is rendered in the dashboard and shipped as
 * docs/PRIVACY.md. One source, so the page a user reads and the file the npm
 * page links to can never say different things.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privacyMarkdown } from '../src/dashboard/web/app/core/privacyText.ts';

test('docs/PRIVACY.md is exactly the statement the dashboard renders', () => {
  const file = readFileSync(join(import.meta.dirname, '..', 'docs', 'PRIVACY.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(file, privacyMarkdown(), 'regenerate docs/PRIVACY.md from core/privacyText.ts');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The npm package is what every installer receives. 0.1.0 shipped
// docs/RELEASE-GATE.md, which quoted a maintainer's personal ledger (request
// counts and dollar totals). Maintainer records stay in the repository; the
// package carries the product and its user-facing docs only.

const MAINTAINER_RECORDS = ['docs/RELEASE-GATE.md', 'docs/RELEASE-PROCESS.md', 'docs/RELIABILITY-PERFORMANCE.md'];

// Figures that have appeared from a personal ledger. A new one belongs here.
const PERSONAL_FIGURES = [/18,422/, /1,574\.42/, /832\.33/, /9,499 (OpenAI )?req/, /675\.61/, /1789\.24/];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('the npm package carries no maintainer records and no personal ledger figures', () => {
  const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path.replaceAll('\\', '/'));
  assert.ok(files.length > 50, 'the pack listing was read');
  for (const record of MAINTAINER_RECORDS) assert.ok(!files.includes(record), `${record} is not shipped`);
  for (const file of files.filter((f) => /\.(md|json|html|txt)$/.test(f))) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    for (const figure of PERSONAL_FIGURES) assert.doesNotMatch(text, figure, `${file} carries a personal ledger figure`);
  }
});

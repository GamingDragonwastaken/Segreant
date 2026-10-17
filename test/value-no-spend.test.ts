/**
 * The value commands on a ledger with no AI spend: they answer at once that
 * there is nothing to measure, instead of walking 90 days of git history and
 * printing 0% realized, an RoI of 0 and $0.00 per commit. Reads the built
 * `dist/` through bin/segreant.mjs, as a user's install does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const command of ['realize', 'roi', 'frontier', 'yield']) {
  test(`${command} on a ledger with no spend says so instead of scoring git history`, () => {
    const home = mkdtempSync(join(tmpdir(), 'segreant-nospend-'));
    try {
      const run = (extra: string[]) => execFileSync(process.execPath, ['bin/segreant.mjs', command, '--repo', '.', ...extra], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const started = Date.now();
      const payload = JSON.parse(run(['--json'])) as { status: string; measured: boolean; next: string[] };
      assert.equal(payload.status, 'no_spend_recorded');
      assert.equal(payload.measured, false);
      assert.ok(payload.next.includes('segreant scan --setup'));
      assert.ok(Date.now() - started < 20_000, 'answered without a git scan');

      const text = run([]);
      assert.match(text, /No AI spend is recorded yet/);
      assert.doesNotMatch(text, /\$0\.00|0 \/ 100|0%/, 'no zero stands in for "nothing to measure"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

/**
 * The value commands on a ledger with no AI spend: they answer at once that
 * there is nothing to measure, instead of walking 90 days of git history and
 * printing 0% realized, an RoI of 0 and $0.00 per commit. Reads the built
 * `dist/` through bin/segreant.mjs, as a user's install does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const command of ['realize', 'roi', 'frontier', 'yield']) {
  test(`${command} on a ledger with no spend says so instead of scoring git history`, () => {
    const home = mkdtempSync(join(tmpdir(), 'segreant-nospend-'));
    try {
      // Git's own trace is the proof that history was not walked. A wall-clock
      // bound here failed on a loaded machine with nothing wrong (24 s for a
      // command that takes 2 s alone).
      const gitTrace = join(home, 'git-trace.log');
      const run = (extra: string[]) => execFileSync(process.execPath, ['bin/segreant.mjs', command, '--repo', '.', ...extra], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1', GIT_TRACE: gitTrace },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const payload = JSON.parse(run(['--json'])) as { status: string; measured: boolean; next: string[] };
      assert.equal(payload.status, 'no_spend_recorded');
      assert.equal(payload.measured, false);
      assert.ok(payload.next.includes('segreant scan --setup'));
      assert.ok(existsSync(gitTrace), 'the repository check ran under the trace');
      const gitCommands = readFileSync(gitTrace, 'utf8');
      assert.match(gitCommands, /git rev-parse/, 'the trace saw the repository check');
      assert.doesNotMatch(gitCommands, /git (log|rev-list|show|blame|diff)\b/, 'answered without a git scan');

      const text = run([]);
      assert.match(text, /No AI spend is recorded yet/);
      assert.doesNotMatch(text, /\$0\.00|0 \/ 100|0%/, 'no zero stands in for "nothing to measure"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('a path that is not a repository is reported as such, even on an empty ledger', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-nospend-'));
  try {
    const missing = join(home, 'no-such-repo');
    let status = 0;
    let output = '';
    try {
      execFileSync(process.execPath, ['bin/segreant.mjs', 'realize', '--repo', missing], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SEGREANT_HOME: home, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      status = e.status;
      output = `${e.stdout}${e.stderr}`;
    }
    assert.equal(status, 1);
    assert.match(output, /Not a git repository/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * `fiscus today` printed nothing about alerts on a fresh install (WP-D06).
 *
 * THE DEFECT. `cmdShow` called `computeAlerts` and printed a line only when
 * the array was non-empty. On the default install every one of the six
 * channels is dark — caps are opt-in, there is no baseline, value is
 * uninstrumented, there is no spend to price — so the array is empty and the
 * surface said nothing. Silence next to a spend figure reads as "nothing
 * fired", which is a negative claim made on the strength of no evidence: the
 * same collapse D-141 removed from `fiscus ops` (`alerts-coverage.test.ts`),
 * left in place on the surface an operator actually types first.
 *
 * THE REPAIR IS WIRING, NOT A NEW DETECTOR. `computeAlertCoverage` already
 * exists, is already what `fiscus ops` and the dashboard read, and already
 * carries a `darkBecause` sentence per channel naming the setting that would
 * light it. `show` now reads the same producer and prints the same reasons, so
 * the three surfaces cannot disagree about what was watching.
 *
 * WHAT THE FIXTURE IS. An empty `FISCUS_HOME`: no config, no ledger rows. That
 * is the counterexample, not a contrived one — it is the install every new
 * operator has for the first hour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertCoverage, type AlertChannel } from '../src/alerts/detect.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const CHANNELS: readonly AlertChannel[] = [
  'budget-cap', 'runaway-loop', 'throttling', 'spend-spike', 'value-crater', 'pricing-trust',
];

function runCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('fiscus today states alert coverage and names why each dark channel cannot fire', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-show-coverage-'));
  try {
    const { code, stdout, stderr } = await runCli(['today'], home);
    assert.equal(code, 0, stderr);

    // The producer's own sentence, not a paraphrase: the surface prints what
    // `alertCoverage` said, so a change to the wording lands on every surface.
    assert.match(stdout, /0 of 6 alert channels are watching/, 'the coverage summary must reach the operator');
    assert.doesNotMatch(stdout, /all clear|no (issues|problems)|nothing wrong|healthy/i);

    // Every dark channel is named with its reason. The reasons are the
    // producer's, so a channel whose reason changes cannot drift out of sync.
    for (const channel of CHANNELS) {
      assert.match(stdout, new RegExp(`${channel}:`), `dark channel ${channel} must be listed`);
    }
    assert.match(stdout, /no daily cap or soft threshold is set/);
    assert.match(stdout, /no runaway velocity threshold is set/);
    assert.match(stdout, /realized value is uninstrumented/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--json carries the same coverage object the text surface renders', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-show-coverage-json-'));
  try {
    const { code, stdout, stderr } = await runCli(['today', '--json'], home);
    assert.equal(code, 0, stderr);
    const payload = JSON.parse(stdout) as { alertCoverage?: ReturnType<typeof alertCoverage>; alerts?: unknown[] };
    assert.ok(payload.alertCoverage, 'a JSON reader must be able to learn what was watching');
    assert.equal(payload.alertCoverage.complete, false);
    assert.equal(payload.alertCoverage.liveChannels, 0);
    assert.deepEqual(
      payload.alertCoverage.channels.map((c) => c.channel).sort(),
      [...CHANNELS].sort(),
    );
    for (const channel of payload.alertCoverage.channels) {
      assert.equal(channel.live, false);
      assert.equal(typeof channel.darkBecause, 'string');
    }
    assert.deepEqual(payload.alerts, [], 'the alert list travels beside the coverage that qualifies it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('week and month do not print coverage they did not compute', async () => {
  // Coverage is read for `today` only, matching where alerts were read. A
  // window that did not evaluate the channels must not claim to have.
  const home = mkdtempSync(join(tmpdir(), 'fiscus-show-coverage-week-'));
  try {
    const { code, stdout } = await runCli(['week'], home);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /alert channels/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fiscus show reads coverage from the producer, not a private verdict', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'showCmd.ts'), 'utf8');
  assert.match(source, /computeAlertCoverage/, 'the surface states coverage rather than composing its own verdict');
});

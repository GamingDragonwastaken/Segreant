// Friction found by the 2026-10-17 usability panel: a first-time user on Windows hit
// each of these before reaching the feature they came for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spendBesideCap } from '../src/budget/guard.ts';
import { listenOrExplain } from '../src/cli/runCmd.ts';
import { coveragePercent } from '../src/cli/billingCmd.ts';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-panel-home-'));

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function cli(args: string[], home: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, SEGREANT_HOME: home, SEGREANT_DB: '', SEGREANT_DEMO: '', NODE_OPTIONS: '' },
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('a refusal never rounds spend that crossed the cap into the cap', () => {
  assert.equal(spendBesideCap(5.004, 5), '$5.004');
  assert.equal(spendBesideCap(5.0000004, 5), 'just over $5.000000', 'below the microdollar it says so in words (PR #142 review)');
  assert.equal(spendBesideCap(4.9999996, 5), 'just under $5.000000');
  assert.equal(spendBesideCap(5.5, 5), '$5.50');
  assert.equal(spendBesideCap(5, 5), '$5.00');
  assert.equal(spendBesideCap(4.999, 5), '$4.999');
});

test('a partial coverage share never reads 100% or 0% (PR #142 review)', () => {
  assert.equal(coveragePercent(996, 1000), '99.6');
  assert.equal(coveragePercent(999_999, 1_000_000), '99.9');
  assert.equal(coveragePercent(1000, 1000), '100');
  assert.equal(coveragePercent(1, 1_000_000), '<0.1');
  assert.equal(coveragePercent(5, 1000), '0.5');
  assert.equal(coveragePercent(424, 1000), '42');
  assert.equal(coveragePercent(0, 1000), '0');
});

test('config.json written by Windows PowerShell (UTF-8 with a byte-order mark) loads', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-bom-'));
  try {
    writeFileSync(join(home, 'config.json'), '﻿' + JSON.stringify({ budget: { dailyUsd: 5 } }), 'utf8');
    const run = await cli(['budget', '--json'], home);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /CONFIG_INVALID/);
    assert.equal(JSON.parse(run.stdout).budget.dailyUsd, 5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a busy port is explained with the flag to use, not an unhandled stack trace', async () => {
  const holder = http.createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const port = (holder.address() as { port: number }).port;
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    const server = http.createServer();
    const ok = await listenOrExplain(server, port, 'dashboard', '--dashboard-port');
    assert.equal(ok, false);
    assert.match(lines.join('\n'), new RegExp(`Port ${port} \\(dashboard\\) is already in use`));
    assert.match(lines.join('\n'), /segreant start --dashboard-port \d+/);
  } finally {
    console.error = original;
    holder.close();
  }
});

test('segreant start on a busy dashboard port exits 1 with the explanation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-busy-'));
  const holder = http.createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const busy = (holder.address() as { port: number }).port;
  const free = http.createServer();
  free.listen(0, '127.0.0.1');
  await once(free, 'listening');
  const proxyPort = (free.address() as { port: number }).port;
  await new Promise<void>((r) => free.close(() => r()));
  try {
    const run = await cli(['start', '--port', String(proxyPort), '--dashboard-port', String(busy)], home);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /is already in use, so Segreant did not start/);
    assert.doesNotMatch(run.stderr, /Unhandled 'error' event|node:events/);
  } finally {
    holder.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('flags with no command apply to the home view: segreant --demo', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-leadflag-'));
  try {
    const run = await cli(['--demo'], home);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /Unknown command/);
    assert.match(run.stdout, /DEMO DATA/);
    const unknown = await cli(['--no-such-flag'], home);
    assert.notEqual(unknown.code, 0);
    const version = await cli(['--version'], home);
    assert.match(version.stdout, /^segreant \d+\.\d+\.\d+/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('billing status reports the recorded comparison and how much of the period it covers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-billing-status-'));
  try {
    assert.equal((await cli(['demo'], home, 120_000)).code, 0);
    const run = await cli(['billing', '--demo'], home);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /not yet scope-comparable/);
    assert.match(run.stdout, /1 recorded comparison\(s\); latest: proj_demo_sample/);
    assert.match(run.stdout, /covers \$[\d.]+ of the \$[\d.]+ Segreant metered across all providers in that period \(\d+%\)/);
    const runs = await cli(['alloc', 'runs', '--demo'], home);
    assert.match(runs.stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z → \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z \(end exclusive\)/,
      'a split that does not start at midnight keeps its times');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('connect api says where requests go and how to change it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-connect-api-'));
  try {
    const run = await cli(['connect', 'api'], home);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Segreant forwards these requests to https:\/\/api\.openai\.com/);
    assert.match(run.stdout, /"upstreams": \{ "openai": "<base URL>" \}/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('budget --recommend gives a plain verdict; the full decision record is behind --detail', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-budget-verdict-'));
  try {
    assert.equal((await cli(['demo'], home, 120_000)).code, 0);
    const plain = await cli(['budget', '--recommend', '--demo'], home, 120_000);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /Is \$[\d.]+ better than (your current \$[\d.]+|having no cap)\?|On this evidence/);
    assert.doesNotMatch(plain.stdout, /claim:budget:cap:input|DAL-\d|Minimax regret/, 'no internal claim ids by default');
    assert.match(plain.stdout, /segreant budget --recommend --detail/);
    const detail = await cli(['budget', '--recommend', '--demo', '--detail'], home, 120_000);
    assert.match(detail.stdout, /Decision — budget-cap:daily/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PR #142 review: coverage uses the comparison\'s day quantization, so a share never exceeds the whole', async () => {
  const { quantizeLocalDays } = await import('../src/billing/reconcile.ts');
  const day = 86_400_000;
  // Two days, each one sub-microdollar request: a period total rounded once from
  // floats is 1 micro, while the comparison's per-day rule gives 2.
  const rows = [0, 1].map((d) => ({ requestId: `r${d}`, tsEpochMs: 20_000 * day + d * day + 1, costUsd: 0.0000006 })) as never[];
  const all = quantizeLocalDays(rows, () => true);
  assert.ok(!('refusal' in all));
  const total = [...all.localByDay.values()].reduce((s, x) => s + x.micros, 0);
  assert.equal(total, 2);
  assert.ok(total >= Math.round(0.0000012 * 1e6), 'never below the subset a comparison would report');
});

test('PR #142 review: single-dash commandless tokens are not swallowed into the home view', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-singledash-'));
  try {
    const bogus = await cli(['-bogus'], home);
    assert.notEqual(bogus.code, 0);
    assert.match(bogus.stderr, /Unknown command: -bogus/);
    const help = await cli(['-h'], home);
    assert.equal(help.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PR #142 review: connect api warns about a doubled version segment', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-connect-v1-'));
  try {
    const run = await cli(['connect', 'api'], home);
    assert.match(run.stdout, /already ends in its version/);
    assert.match(run.stdout, /without \/v1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PR #142 review: coverage is withheld once the ledger has moved since the comparison was recorded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-coverage-moved-'));
  try {
    assert.equal((await cli(['demo'], home, 120_000)).code, 0);
    const before = await cli(['billing', '--demo'], home);
    assert.match(before.stdout, /covers \$/);
    // Prune into the recorded period: the comparison's saved local figure no
    // longer matches what the ledger holds now.
    const { Store } = await import('../src/store/db.ts');
    const store = new Store(join(home, 'demo.db'));
    const run = store.reconciliationRuns(1)[0]!.result;
    store.prune(run.periodStartMs + 3 * 86_400_000);
    store.close();
    const after = await cli(['billing', '--demo'], home);
    assert.doesNotMatch(after.stdout, /covers \$/, 'no share mixing a recorded figure with a live one');
    assert.match(after.stdout, /coverage withheld: the ledger has changed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PR #142 review: the closing line tells weak assurance apart from no winner', async () => {
  const { budgetClosingLine } = await import('../src/cli/valueCmd.ts');
  assert.match(budgetClosingLine(true, null), /Re-run with --apply/);
  const favoursNew = budgetClosingLine(false, { status: 'proven_dominant', action: 'apply_recommended' });
  assert.match(favoursNew, /favours the new cap, but its inputs are not verified enough/);
  assert.doesNotMatch(favoursNew, /does not show it/, 'must not contradict a proven verdict');
  assert.match(budgetClosingLine(false, { status: 'proven_dominant', action: 'keep_current' }), /current setting does better/);
  assert.match(budgetClosingLine(false, { status: 'undetermined' }), /this data does not show it/);
  assert.match(budgetClosingLine(false, { status: 'undetermined' }, true), /already has this cap/, 'equal caps are not a missing proof (PR #142 review)');
});

test('a long-running flag with no command is reported, not swallowed by the home view (PR #142 review)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-watch-'));
  try {
    for (const flag of ['--watch', '--serve']) {
      const r = await cli([flag], home);
      assert.equal(r.code, 2, `${flag}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${flag} does nothing for "segreant home"`));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

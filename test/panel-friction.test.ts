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
  assert.equal(spendBesideCap(5.0000004, 5), '$5.000000', 'stops at the microdollar');
  assert.equal(spendBesideCap(5.5, 5), '$5.50');
  assert.equal(spendBesideCap(5, 5), '$5.00');
  assert.equal(spendBesideCap(4.999, 5), '$4.999');
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
    assert.match(runs.stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z → \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \(end exclusive\)/,
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

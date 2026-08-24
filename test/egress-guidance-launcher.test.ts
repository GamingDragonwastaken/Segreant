import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { egressReceiptPath } from '../src/egress/receipts.ts';
import { probeProxyState } from '../src/egress/proxyHealth.ts';
import { buildGuide, type GuideFacts } from '../src/guide.ts';
import { gatherGuideFacts } from '../src/cli/opsCmd.ts';
import { handleGuide } from '../src/dashboard/routes.ts';

const execFileAsync = promisify(execFile);

function freshFacts(over: Record<string, unknown> = {}): GuideFacts {
  return {
    demo: false,
    port: 8090,
    dashboardPort: 8091,
    proxyUp: false,
    requestsAllTime: 0,
    spend30dUsd: 0,
    dailyCapUsd: null,
    outcomeSignals: 0,
    realizationUnits: 0,
    laborRateSet: false,
    ...over,
  } as GuideFacts;
}

test('pure guide renders receipt refusal as a local egress block, never proxy-down/start', () => {
  const report = buildGuide(freshFacts({
    proxyStatus: {
      kind: 'blocked_by_egress',
      code: 'receipt_integrity_failed',
      message: 'receipt history is invalid',
      action: 'run fiscus egress verify and repair/restore the present history',
    },
  }));
  const text = JSON.stringify(report);
  assert.match(text, /receipt_integrity_failed|receipt history|egress verify/i);
  assert.doesNotMatch(text, /fiscus start|proxy.*not reachable/i);
  assert.deepEqual(report.next.commands, ['fiscus egress verify']);
  assert.ok(report.next.notice?.includes('receipt_integrity_failed'));
  assert.ok(report.next.notice?.includes('repair/restore'));
  for (const command of report.next.commands) {
    assert.doesNotMatch(command, /^run /i);
    assert.notEqual(command, 'run fiscus egress verify and repair/restore the present receipt history before retrying');
    assert.notEqual(command, 'receipt history is invalid');
  }
});

test('guide commands contain executable PowerShell assignments without decorative prose separators', () => {
  const commands = buildGuide(freshFacts({ proxyUp: true })).next.commands;
  assert.deepEqual(commands, [
    '$env:ANTHROPIC_BASE_URL="http://localhost:8090"',
    '$env:OPENAI_BASE_URL="http://localhost:8090/v1"',
  ]);
  for (const command of commands) {
    assert.doesNotMatch(command, /·|then run|watch requests/i);
  }
});

test('proxy guidance probes the supplied config port through the real loopback transport', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-guide-health-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url ?? ''}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const supplied = { ...structuredClone(DEFAULT_CONFIG), port: address.port };
  try {
    const state = await probeProxyState(supplied);
    assert.equal(state.kind, 'up');
    assert.deepEqual(requests, ['GET /__fiscus/health']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('proxy health has no production-reachable test transport override', async () => {
  const proxyHealth = await import('../src/egress/proxyHealth.ts');
  const ops = await import('../src/cli/opsCmd.ts');
  assert.equal('setProxyProbeFetchForTests' in proxyHealth, false);
  assert.equal('setProxyProbeFetchForTests' in ops, false);
});

test('CLI proxy probe and guide facts preserve typed receipt refusal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-guide-refusal-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  writeFileSync(egressReceiptPath(), '', 'utf8');
  try {
    const state = await probeProxyState(DEFAULT_CONFIG);
    assert.equal(state.kind, 'blocked_by_egress');
    assert.equal(state.code, 'receipt_integrity_failed');
    const facts = await gatherGuideFacts();
    assert.equal(facts.proxyStatus?.kind, 'blocked_by_egress');
    assert.equal(facts.proxyStatus?.code, 'receipt_integrity_failed');
  } finally {
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor renders receipt refusal as boundary repair guidance, not proxy startup guidance', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-doctor-refusal-'));
  writeFileSync(join(home, 'egress-receipts.jsonl'), '', 'utf8');
  try {
    const result = await execFileAsync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'doctor'], {
      timeout: 30_000,
      env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' },
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /receipt_integrity_failed|egress verify/i);
    assert.doesNotMatch(output, /start with "fiscus start"/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI guide renders recovery notice separately from its executable command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-guide-cli-refusal-'));
  writeFileSync(join(home, 'egress-receipts.jsonl'), '', 'utf8');
  try {
    const result = await execFileAsync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'guide'], {
      timeout: 30_000,
      env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' },
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /fiscus egress verify/i);
    assert.match(output, /receipt_integrity_failed|repair\/restore/i);
    assert.doesNotMatch(output, /start with "fiscus start"/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dashboard guide adapter returns truthful blocked-by-egress state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-dashboard-guide-refusal-'));
  const previous = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  writeFileSync(egressReceiptPath(), '', 'utf8');
  let body = '';
  let resolveBody!: () => void;
  const done = new Promise<void>((resolve) => { resolveBody = resolve; });
  const res = {
    writeHead: () => undefined,
    end: (chunk?: string | Buffer) => { body = chunk?.toString() ?? ''; resolveBody(); },
  } as never;
  const store = new (await import('../src/store/db.ts')).Store(':memory:');
  try {
    handleGuide({
      req: {} as never,
      res,
      url: new URL('http://127.0.0.1/api/guide'),
      store,
      config: structuredClone(DEFAULT_CONFIG),
      version: 'test',
      configPersistence: { load: () => structuredClone(DEFAULT_CONFIG), save: () => undefined },
    });
    await done;
    assert.match(body, /blocked_by_egress|receipt_integrity_failed|egress verify/i);
    assert.doesNotMatch(body, /fiscus start|proxy.*not reachable/i);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('checked-out npm entry points declare a build freshness lifecycle', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.prestart, 'npm run build');
  assert.equal(pkg.scripts?.prefiscus, 'npm run build');
  assert.equal(pkg.scripts?.predemo, 'npm run build');
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const gettingStarted = readFileSync(join(import.meta.dirname, '..', 'docs', 'GETTING-STARTED.md'), 'utf8');
  const claude = readFileSync(join(import.meta.dirname, '..', 'CLAUDE.md'), 'utf8');
  const landing = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  assert.doesNotMatch(readme, /node(?:\s+--[^\n]+)?\s+bin\/fiscus\.mjs/);
  assert.doesNotMatch(gettingStarted, /node(?:\s+--[^\n]+)?\s+bin\/fiscus\.mjs/);
  assert.doesNotMatch(claude, /node(?:\s+--[^\n]+)?\s+bin\/fiscus\.mjs/);
  assert.doesNotMatch(landing, /node(?:\s+--[^\n]+)?\s+bin\/fiscus\.mjs/);
  assert.match(readme, /npm run demo/);
  assert.match(readme, /npm run start/);
  assert.match(claude, /npm run demo/);
  assert.match(claude, /npm run start -- --demo/);
  assert.match(landing, /npm run start/);
  assert.match(landing, /navigator\.clipboard\.writeText\('npm run start'\)/);
});

test('invalid config ports fail closed before guide command interpolation', () => {
  const cases: Array<{ port: unknown; expected: number }> = [
    { port: '8090; $env:OPENAI_API_KEY="stolen"', expected: DEFAULT_CONFIG.port },
    { port: 0, expected: DEFAULT_CONFIG.port },
    { port: 65536, expected: DEFAULT_CONFIG.port },
    { port: 8090.5, expected: DEFAULT_CONFIG.port },
    { port: 1, expected: 1 },
    { port: 65535, expected: 65535 },
  ];
  for (const entry of cases) {
    const home = mkdtempSync(join(tmpdir(), 'fiscus-config-port-'));
    const previous = process.env.FISCUS_HOME;
    process.env.FISCUS_HOME = home;
    try {
      writeFileSync(join(home, 'config.json'), JSON.stringify({
        port: entry.port,
        dashboardPort: '8091; Write-Output compromised',
      }), 'utf8');
      const loaded = loadConfig();
      assert.equal(loaded.port, entry.expected, JSON.stringify(entry));
      assert.equal(loaded.dashboardPort, DEFAULT_CONFIG.dashboardPort, JSON.stringify(entry));
      const commands = buildGuide(freshFacts({ proxyUp: true, port: loaded.port })).next.commands;
      assert.deepEqual(commands, [
        `$env:ANTHROPIC_BASE_URL="http://localhost:${entry.expected}"`,
        `$env:OPENAI_BASE_URL="http://localhost:${entry.expected}/v1"`,
      ], JSON.stringify(entry));
      assert.doesNotMatch(JSON.stringify(commands), /[;&|`]/, JSON.stringify(entry));
    } finally {
      if (previous === undefined) delete process.env.FISCUS_HOME;
      else process.env.FISCUS_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('classic dashboard guide renders structured recovery notice separately from commands', () => {
  const classic = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
  assert.match(classic, /g\.next\.notice/);
  assert.match(classic, /gcmds/);
});

test('the npm launcher smoke command remains local and bounded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-launcher-smoke-'));
  try {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd run fiscus -- egress status --json']
      : ['run', 'fiscus', '--', 'egress', 'status', '--json'];
    const result = await execFileAsync(command, args, {
      cwd: join(import.meta.dirname, '..'),
      timeout: 180_000,
      env: { ...process.env, FISCUS_HOME: home, FISCUS_DB: join(home, 'fiscus.db'), NODE_OPTIONS: '' },
    });
    assert.match(result.stdout + result.stderr, /egress|local_locked|controlled_cloud/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

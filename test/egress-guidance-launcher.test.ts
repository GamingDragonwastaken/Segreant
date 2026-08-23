import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { egressReceiptPath } from '../src/egress/receipts.ts';
import { buildGuide, type GuideFacts } from '../src/guide.ts';
import { gatherGuideFacts, probeProxyState } from '../src/cli/opsCmd.ts';
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

/**
 * The running proxy follows budget edits made to config.json by another
 * process (the CLI, an editor), fails closed while the file is invalid, and
 * never lifts a cap because the file disappeared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveBudget, createProxyServer, BudgetConfigUnavailable } from '../src/proxy/server.ts';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG, type SegreantConfig } from '../src/config.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  const file = join(dir, 'config.json');
  let stamp = Date.now() / 1000 - 100;
  let next: SegreantConfig | Error = structuredClone(DEFAULT_CONFIG);
  const write = (value: SegreantConfig | Error) => {
    next = value;
    writeFileSync(file, '{}');
    stamp += 10; // a distinct mtime per write, whatever the filesystem's resolution
    utimesSync(file, stamp, stamp);
  };
  writeFileSync(file, '{}');
  utimesSync(file, stamp, stamp);
  const config = structuredClone(DEFAULT_CONFIG);
  const budget = liveBudget(config, {
    intervalMs: 0,
    path: () => file,
    load: () => { if (next instanceof Error) throw next; return structuredClone(next); },
  });
  return { dir, file, config, budget, write };
}

test('a cap written to the file by another process governs the running proxy', () => {
  const { dir, budget, write } = setup();
  try {
    assert.equal(budget().dailyUsd, null);
    const capped = structuredClone(DEFAULT_CONFIG);
    capped.budget.dailyUsd = 5;
    write(capped);
    assert.equal(budget().dailyUsd, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid file fails closed until it is repaired, then enforcement resumes', () => {
  const { dir, budget, write } = setup();
  try {
    write(new Error('budget.dailyUsd must be null or a finite non-negative USD value'));
    assert.throws(() => budget(), /dailyUsd/);
    assert.throws(() => budget(), /dailyUsd/, 'still closed on the next request, not only the first');
    const repaired = structuredClone(DEFAULT_CONFIG);
    repaired.budget.dailyUsd = 2;
    write(repaired);
    assert.equal(budget().dailyUsd, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting config.json never lifts a cap that is in force', () => {
  const { dir, file, budget, write } = setup();
  try {
    const capped = structuredClone(DEFAULT_CONFIG);
    capped.budget.dailyUsd = 3;
    write(capped);
    assert.equal(budget().dailyUsd, 3);
    rmSync(file);
    assert.equal(budget().dailyUsd, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is not re-read faster than the interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}');
    let loads = 0;
    const budget = liveBudget(structuredClone(DEFAULT_CONFIG), {
      intervalMs: 60_000, path: () => file, load: () => { loads += 1; return structuredClone(DEFAULT_CONFIG); },
    });
    for (let i = 0; i < 100; i++) budget();
    assert.equal(loads, 1, 'read once on the first check, then never re-parsed while unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first check reads the file, so an edit made before the proxy started still governs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}');
    const stale = structuredClone(DEFAULT_CONFIG); // what start loaded: no cap
    const onDisk = structuredClone(DEFAULT_CONFIG);
    onDisk.budget.dailyUsd = 4; // written while start awaited its pricing refresh
    const budget = liveBudget(stale, { intervalMs: 0, path: () => file, load: () => structuredClone(onDisk) });
    assert.equal(budget().dailyUsd, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stat failure other than a missing file fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-budget-'));
  try {
    // A NUL byte makes stat fail with a non-ENOENT error on every platform.
    const budget = liveBudget(structuredClone(DEFAULT_CONFIG), {
      intervalMs: 0, path: () => join(dir, 'config\u0000.json'), load: () => structuredClone(DEFAULT_CONFIG),
    });
    assert.throws(() => budget(), BudgetConfigUnavailable, 'an unreadable path is not a deletion');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the running proxy refuses while config is invalid and resumes once it is repaired, without a restart', async () => {
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.anthropic = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let broken = true;
  const store = new Store(':memory:');
  const proxy = createProxyServer({ store, config, budget: () => {
    if (broken) throw new BudgetConfigUnavailable(new Error('budget.dailyUsd must be null or a finite non-negative USD value'));
    return config.budget;
  } });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const send = () => fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
  });
  try {
    const refused = await send();
    assert.equal(refused.status, 503);
    await refused.text();
    broken = false;
    const resumed = await send();
    assert.equal(resumed.status, 200, 'a repaired file resumes forwarding: config failures do not latch');
    await resumed.text();
  } finally {
    proxy.closeAllConnections?.();
    await new Promise<void>((r) => proxy.close(() => r()));
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    store.close();
  }
});

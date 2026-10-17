// Where a declared price must NOT reach: the provider is never called while the
// declarations file is broken, and the sample data never takes a real declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'segreant-override-boundaries-'));
process.env.SEGREANT_HOME = home;

const { createProxyServer } = await import('../src/proxy/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { Store } = await import('../src/store/db.ts');
const { setPriceOverride, removePriceOverride, overridesPath } = await import('../src/cost/overrides.ts');
const { seedDemo } = await import('../src/demo/seed.ts');

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: http.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

test('a broken declarations file stops forwarding before the provider is called, and repairing it resumes (PR #146 review)', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upstreamBase = await listen(upstream);
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const store = new Store(join(home, 'proxy.db'));
  const proxy = createProxyServer({ store, config });
  const proxyBase = await listen(proxy);
  const send = () => fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
  });
  try {
    mkdirSync(join(home, 'pricing'), { recursive: true });
    writeFileSync(overridesPath(), '{ "version": 1, "models": { "acme": { "kind": "rate" } } }');
    const refused = await send();
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { error?: { code?: string } }).error?.code, 'budget_enforcement_unavailable');
    assert.equal(upstreamRequests, 0, 'nothing is sent while a declared price cannot be read');

    rmSync(overridesPath());
    const sent = await send();
    assert.equal(sent.status, 200, 'repairing the file resumes forwarding without a restart');
    await sent.text();
    assert.equal(upstreamRequests, 1);
  } finally {
    await close(proxy);
    await close(upstream);
    store.close();
  }
});

test('the sample data is priced from the card, whatever the user declared (PR #146 review)', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const seed = (name: string) => {
    const store = new Store(join(home, name));
    try { return seedDemo(store, { now }); } finally { store.close(); }
  };
  const plain = seed('demo-plain.db');
  setPriceOverride('gpt-4o', { kind: 'free' });
  setPriceOverride('claude-sonnet-4-6', { kind: 'rate', input: '99', output: '99' });
  try {
    const declared = seed('demo-declared.db');
    assert.equal(declared.totalCostUsd, plain.totalCostUsd);
    assert.equal(declared.requests, plain.requests);
  } finally {
    removePriceOverride('gpt-4o');
    removePriceOverride('claude-sonnet-4-6');
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));

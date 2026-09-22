import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/proxy/server.ts';
import { DEFAULT_CONFIG, type FiscusConfig } from '../src/config.ts';
import type { Store } from '../src/store/db.ts';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('proxy fails closed before upstream dial when budget evaluation cannot read the ledger', async () => {
  const previousHome = process.env.FISCUS_HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'fiscus-budget-fail-closed-'));
  process.env.FISCUS_HOME = testHome;
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upstreamBase = await listen(upstream);
  const config: FiscusConfig = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const failingStore = {
    matchingOpenAiScope: () => null,
    spendBetween: () => { throw new Error('ledger unavailable'); },
    spendForSession: () => { throw new Error('ledger unavailable'); },
    spendInWindow: () => { throw new Error('ledger unavailable'); },
    insertRequest: () => { throw new Error('ledger unavailable'); },
  } as unknown as Store;
  const proxy = createProxyServer({ store: failingStore, config });
  const proxyBase = await listen(proxy);

  try {
    const response = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 503);
    const body = await response.json() as { error?: { type?: string; code?: string } };
    assert.equal(body.error?.type, 'fiscus_budget_unavailable');
    assert.equal(body.error?.code, 'budget_enforcement_unavailable');
    assert.equal(upstreamRequests, 0, 'a failed budget read must not reach the provider');
  } finally {
    await close(proxy);
    await close(upstream);
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('proxy opens an accounting circuit after a request cannot be persisted', async () => {
  const previousHome = process.env.FISCUS_HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'fiscus-budget-accounting-circuit-'));
  process.env.FISCUS_HOME = testHome;
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upstreamBase = await listen(upstream);
  const config: FiscusConfig = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const failingStore = {
    matchingOpenAiScope: () => null,
    spendBetween: () => 0,
    spendInWindow: () => ({ costUsd: 0 }),
    insertRequest: () => { throw new Error('disk full'); },
  } as unknown as Store;
  const proxy = createProxyServer({ store: failingStore, config });
  const proxyBase = await listen(proxy);
  const request = () => fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
  });

  try {
    const first = await request();
    assert.equal(first.status, 200, 'the already-completed provider response cannot be retracted');
    const second = await request();
    assert.equal(second.status, 503, 'future requests must stop after accounting loss');
    const body = await second.json() as { error?: { type?: string; code?: string } };
    assert.equal(body.error?.type, 'fiscus_budget_unavailable');
    assert.equal(body.error?.code, 'budget_enforcement_unavailable');
    assert.equal(upstreamRequests, 1, 'only the request that lost its persistence race may reach the provider');
  } finally {
    await close(proxy);
    await close(upstream);
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});

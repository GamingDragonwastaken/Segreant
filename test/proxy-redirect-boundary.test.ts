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
import { Store } from '../src/store/db.ts';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('proxy strips upstream Location so a client cannot follow outside Fiscus policy', async () => {
  const previousHome = process.env.FISCUS_HOME;
  const testHome = mkdtempSync(join(tmpdir(), 'fiscus-proxy-redirect-'));
  process.env.FISCUS_HOME = testHome;
  let redirectedRequests = 0;
  const sink = http.createServer((_req, res) => {
    redirectedRequests += 1;
    res.writeHead(200);
    res.end('unexpected redirect follow');
  });
  const sinkBase = await listen(sink);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(307, { location: `${sinkBase}/capture`, 'content-type': 'text/plain' });
    res.end('provider redirect');
  });
  const upstreamBase = await listen(upstream);
  const config: FiscusConfig = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  const store = new Store(':memory:');
  const proxy = createProxyServer({ store, config });
  const proxyBase = await listen(proxy);

  try {
    const response = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), null, 'redirect destinations must not escape the configured Fiscus transport policy');
    assert.equal(redirectedRequests, 0);
  } finally {
    await close(proxy);
    store.close();
    await close(upstream);
    await close(sink);
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  }
});

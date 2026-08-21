import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG, type FiscusConfig } from '../src/config.ts';
import { createProxyServer } from '../src/proxy/server.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('live settings: saving a hard cap through the dashboard governs the already-running proxy', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
      choices: [{ message: { content: 'ok' } }],
    }));
  });
  const upstreamBase = await listen(upstream);
  const store = new Store(':memory:');
  const config: FiscusConfig = structuredClone(DEFAULT_CONFIG);
  config.upstreams.openai = upstreamBase;
  let persisted = structuredClone(config);
  const proxy = createProxyServer({ store, config });
  const proxyBase = await listen(proxy);
  const dashboard = createDashboardServer({
    store,
    config,
    version: 'test',
    configPersistence: {
      load: () => structuredClone(persisted),
      save: (next) => { persisted = structuredClone(next); },
    },
  });
  const dashboardBase = await listen(dashboard);

  const request = () => fetch(`${proxyBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
  });

  try {
    const first = await request();
    assert.equal(first.status, 200, 'traffic is initially allowed with no configured cap');

    const update = await fetch(`${dashboardBase}/api/settings/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fiscus-local': '1' },
      body: JSON.stringify({ budget: { dailyUsd: 0.000001 } }),
    });
    assert.equal(update.status, 200);
    assert.equal(persisted.budget.dailyUsd, 0.000001, 'the selected limit is persisted');

    const blocked = await request();
    assert.equal(blocked.status, 429, 'the existing proxy reads the newly saved budget instead of a stale nested object');
    const body = (await blocked.json()) as { error?: { type?: string } };
    assert.equal(body.error?.type, 'fiscus_budget_block');
  } finally {
    await close(dashboard);
    await close(proxy);
    await close(upstream);
    store.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, validateBudgetConfig } from '../src/config.ts';
import { createProxyServer } from '../src/proxy/server.ts';
import { Store } from '../src/store/db.ts';

const invalidBudgets: Array<[string, unknown]> = [
  ['string cap', { dailyUsd: '5' }],
  ['boolean cap', { dailyUsd: false }],
  ['negative cap', { dailyUsd: -1 }],
  ['huge cap', { dailyUsd: 1e300 }],
  ['overflowed JSON number', { dailyUsd: Infinity }],
  ['unknown cap key', { dailyUSd: 5 }],
  ['nested cap garbage', { sessionUsd: { value: 5 } }],
  ['array cap garbage', { runawayMaxUsd: [5] }],
  ['string enforcement switch', { capIncludesImported: 'false' }],
  ['zero runaway window', { runawayWindowSec: 0 }],
];

for (const [name, override] of invalidBudgets) {
  test(`persisted config refuses ${name}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'segreant-config-matrix-'));
    const previous = process.env.SEGREANT_HOME;
    process.env.SEGREANT_HOME = home;
    try {
      // Infinity must reach the JSON parser as an overflowing numeric literal,
      // not JSON.stringify's null (which deliberately means unlimited).
      const text = name === 'overflowed JSON number'
        ? '{"budget":{"dailyUsd":1e999}}'
        : JSON.stringify({ budget: override });
      writeFileSync(join(home, 'config.json'), text);
      assert.throws(loadConfig, /CONFIG_INVALID/);
    } finally {
      if (previous === undefined) delete process.env.SEGREANT_HOME;
      else process.env.SEGREANT_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('NaN, nested root garbage and unknown root keys cannot become a valid config', () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-config-root-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  try {
    for (const text of ['{"budget":{"dailyUsd":NaN}}', '{"budgets":{"dailyUsd":5}}', '{"budget":null}', '{"budget":[]}']) {
      writeFileSync(join(home, 'config.json'), text);
      assert.throws(loadConfig, /CONFIG_INVALID/, text);
    }
    assert.throws(() => validateBudgetConfig({ ...DEFAULT_CONFIG.budget, dailyUsd: NaN }), /CONFIG_INVALID/);
  } finally {
    if (previous === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('each invalid budget class refuses proxy forwarding before the local provider is dialled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-config-proxy-'));
  const previous = process.env.SEGREANT_HOME;
  process.env.SEGREANT_HOME = home;
  let forwarded = 0;
  const upstream = http.createServer((_req, res) => {
    forwarded++;
    res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const store = new Store(join(home, 'segreant.db'));
  try {
    for (const [name, override] of [...invalidBudgets, ['NaN runtime cap', { dailyUsd: NaN }] as [string, unknown]]) {
      const config = structuredClone(DEFAULT_CONFIG);
      config.upstreams.openai = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      config.budget = { ...config.budget, ...override as object };
      const proxy = createProxyServer({ store, config });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      try {
        const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
        });
        assert.equal(response.status, 503, name);
        const body = await response.json() as { error: { code: string } };
        assert.equal(body.error.code, 'budget_enforcement_unavailable', name);
        assert.equal(forwarded, 0, name);
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    }
  } finally {
    store.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

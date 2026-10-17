// A request Segreant refuses before it reaches the provider has a known cost of zero.
// It used to be recorded as `unpriced`, so every cap refusal after the first said
// "1 of 835 requests in this window are unpriced" (2026-10-17 usability panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/proxy/server.ts';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { summarizeBasis } from '../src/cost/basis.ts';
import { setReceiptWriteHookForTests } from '../src/egress/receipts.ts';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-not-sent-home-'));

test('a cap refusal is recorded as not sent, and later refusals do not call it unpriced', async () => {
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 200 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.anthropic = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  config.budget = { ...config.budget, dailyUsd: 0.001 };
  const store = new Store(':memory:');
  const proxy = createProxyServer({ store, config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const send = () => fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
  });
  try {
    const first = await send();
    assert.equal(first.status, 200, 'the first request is under the cap');
    await first.text();
    const blocked = await send();
    assert.equal(blocked.status, 429);
    await blocked.text();
    const again = await send();
    assert.equal(again.status, 429);
    const body = await again.text();
    assert.doesNotMatch(body, /unpriced/, 'an earlier refusal is not a missing price');
    assert.match(body, /complete for this window/);

    const rows = store.pricingEvidenceByModel(0, Date.now() + 1000);
    const summary = summarizeBasis(rows);
    const refused = summary.cohorts.find((c) => c.id === 'not_sent');
    assert.equal(refused?.requests, 2);
    assert.equal(refused?.costUsd, 0);
    assert.equal(summary.cohorts.some((c) => c.id === 'unpriced'), false);
    assert.equal(summary.headline, 'list_cost', 'refused requests do not change what the total is called');

    // The shared economic read model skips them too, so a refusal cannot make
    // attribution partial (PR #143 review).
    const economic = store.economicRequestRowsInRange(0, Date.now() + 1000);
    assert.equal(economic.length, 1, 'only the request that was sent is spend');
  } finally {
    proxy.closeAllConnections?.();
    await new Promise<void>((r) => proxy.close(() => r()));
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    store.close();
  }
});

test('a receipt failure after the provider answered keeps an unknown cost, not not_sent (PR #143 review)', async () => {
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 200 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams.anthropic = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const store = new Store(':memory:');
  const proxy = createProxyServer({ store, config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  // Receipts are written preflight, dial_started, response_received: fail the
  // third, which is written after the provider has already answered.
  let writes = 0;
  const restore = setReceiptWriteHookForTests(() => {
    writes += 1;
    if (writes === 3) throw new Error('disk full');
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    assert.equal(writes >= 3, true, 'the response receipt was attempted');
    const cohorts = summarizeBasis(store.pricingEvidenceByModel(0, Date.now() + 1000)).cohorts.map((c) => c.id);
    assert.equal(cohorts.includes('not_sent'), false, 'the provider may already have charged it');
    assert.equal(cohorts.includes('unpriced'), true);
  } finally {
    restore();
    proxy.closeAllConnections?.();
    await new Promise<void>((r) => proxy.close(() => r()));
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    store.close();
  }
});
